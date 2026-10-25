'use strict';

const { LatencyModel } = require('./latency-model');

const HISTORY_KEEP_MS = 20000; // Länge des Zählerverlaufs (begrenzt peakWindowMs und feedForwardAbortWindowS)
const toBool = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';

/**
 * Regelkern der Nulleinspeisung (mehrere Zonen an einem BMS).
 *
 * Je Zone: eigener Zähler (Bezug +, Einspeisung −), Wechselrichter, Maximalleistung, Vorsteuerung für
 * getaktete Großlasten und Latenzkompensation. Gemeinsam: BMS-Prüfung, SoC-Akkuschutz mit Hysterese
 * und ein Gesamtlimit, das fair (Max-Min-Fairness) auf die Zonen verteilt wird.
 *
 * io.get(id)            -> { val, ts } | undefined   zwischengespeicherte Fremdzustände
 * io.setSetpoint(id, v) -> Promise                   Sollwert schreiben (ack=false)
 * io.publish(rel, v)    -> Promise                   eigene Zustände
 */
class NulleinspeisungCore {
    constructor({ cfg, io, log, now, enabled = true }) {
        this.cfg = cfg;
        this.io = io;
        this.log = log;
        this.now = now || Date.now;
        this.enabled = enabled;
        this.configOk = false;
        this.isBatteryDisabled = false;
        this.lastGlobalBlock = null;
        // Latenzmodell: Schlüssel ist die WR-setId (nicht Zonenname), sodass jeder WR
        // individuell seine Ansteuerungszeiten lernt.
        this.latencyModel = new LatencyModel(cfg.maxLatencyTimeoutS * 1000, log);
        this.zones = cfg.zones.map((z) => ({
            ...z,
            allInverters: [],
            inverters: [],
            structSig: '',
            activeSig: '',
            waiting: false,
            lockUntil: 0,
            lastTarget: 0,
            // lastAlloc: letzte gesendete Einzelzuteilung pro WR { setId -> W }
            // Wird bei startLatencyLock benötigt, um δW je WR zu berechnen.
            lastAlloc: {},
            // wrPending: laufende Latenz-Messungen je WR { setId -> { target, writeTs, deltaW } }
            wrPending: {},
            blockReason: null,
            ff: { active: false, base: 0, predicted: 0, startTs: 0, lastPeakTs: 0 },
            history: [],
        }));
    }

    zone(name) { return this.zones.find((z) => z.name === name); }
    zoneByMeter(id) { return this.zones.find((z) => z.meterId === id); }
    activeZones() { return this.zones.filter((z) => z.active); }

    /** Pflicht-Datenpunkte, die beim Start existieren müssen. */
    requiredIds() {
        const c = this.cfg;
        const out = [['Batterie-SoC', c.socId]];
        if (c.checkBmsOnline) out.push(['BMS Online', c.bmsOnlineId]);
        if (c.checkBmsDischargeLimit) out.push(['BMS Entladelimit', c.bmsDischargeLimitId]);
        if (c.checkBmsProtection) out.push(['BMS Schutz', c.bmsProtectionId]);
        for (const z of this.zones) out.push([`[${z.name}] Zähler`, z.meterId]);
        return out;
    }

    /** Alle Fremd-Datenpunkte, die beobachtet werden müssen. */
    watchedIds() {
        const c = this.cfg;
        const ids = new Set([c.socId]);
        if (c.checkBmsOnline) ids.add(c.bmsOnlineId);
        if (c.checkBmsDischargeLimit) ids.add(c.bmsDischargeLimitId);
        if (c.checkBmsProtection) ids.add(c.bmsProtectionId);
        for (const z of this.zones) {
            ids.add(z.meterId);
            for (const wr of z.allInverters) { ids.add(wr.setId); ids.add(wr.actualId); }
        }
        return ids;
    }

    // ---------- Helfer ----------
    readNum(id) {
        const s = this.io.get(id);
        if (!s || s.val === null || s.val === undefined || s.val === '') return null;
        const n = Number(s.val);
        return Number.isFinite(n) ? n : null;
    }

    wrActualTotal(zone) {
        let sum = 0;
        for (const wr of zone.inverters) {
            const v = this.readNum(wr.actualId);
            if (v === null) return null;
            sum += v * this.cfg.wrActualScale;
        }
        return sum;
    }

    zoneMax(zone) { return Math.min(zone.maxW, zone.inverters.reduce((a, wr) => a + wr.maxW, 0)); }

    /** Verteilt die Zonenleistung gleichmäßig, begrenzt durch maxW je Wechselrichter. */
    distribute(zone, total) {
        const inv = zone.inverters;
        const alloc = inv.map(() => 0);
        let remaining = Math.min(total, this.zoneMax(zone));
        let open = inv.map((_, i) => i);
        for (let iter = 0; iter < inv.length && remaining > 0.5 && open.length; iter++) {
            const share = remaining / open.length;
            const next = [];
            for (const i of open) {
                const give = Math.min(share, inv[i].maxW - alloc[i]);
                alloc[i] += give;
                remaining -= give;
                if (alloc[i] < inv[i].maxW - 0.0001) next.push(i);
            }
            open = next;
        }
        return alloc.map((v) => Math.floor(v));
    }

    /** Schreibt einen Sollwert (im Testlauf nur Protokoll). */
    writeSet(wr, value) {
        if (this.cfg.dryRun) {
            this.log.info(`[Testlauf] ${wr.setId} = ${value} W`);
            return Promise.resolve();
        }
        return this.io.setSetpoint(wr.setId, value);
    }

    setAll(zone, values) {
        return Promise.all(zone.inverters.map((wr, i) => this.writeSet(wr, values[i])));
    }

    stopZone(zone) {
        if (zone.lastTarget !== 0) {
            this.setAll(zone, zone.inverters.map(() => 0));
            zone.lastTarget = 0;
        }
        this.resetLatencyLock(zone);
    }

    // ---------- Latenzsperre ----------
    resetLatencyLock(zone) {
        zone.waiting = false;
        zone.lockUntil = 0;
        zone.wrPending = {};
    }

    /**
     * Latenzsperre starten: für jeden WR wird δW = |neue Zuteilung − alte Zuteilung| berechnet,
     * eine individuelle Schätzung aus dem Lernmodell geholt und der Timeout der Zone auf das
     * Maximum aller WR-Timeouts gesetzt. So wartet die Zone, bis der langsamste WR fertig ist,
     * aber wir lernen für jeden WR separat.
     *
     * @param {object} zone       Zonen-Objekt
     * @param {number[]} newAlloc Neue Einzelzuteilungen in W (parallel zu zone.inverters)
     * @param {number}  sent      Summe der neuen Zuteilung (= neues zone.lastTarget)
     */
    startLatencyLock(zone, newAlloc, sent) {
        const now = this.now();
        zone.wrPending = {};
        let maxTimeoutMs = 0;

        for (let i = 0; i < zone.inverters.length; i++) {
            const wr = zone.inverters[i];
            const newW = newAlloc[i];
            const oldW = zone.lastAlloc[wr.setId] !== undefined ? zone.lastAlloc[wr.setId] : zone.lastTarget / zone.inverters.length;
            const deltaW = Math.abs(newW - oldW);

            if (deltaW < 1) continue; // keine nennenswerte Änderung, diesen WR nicht tracken

            const estimatedMs = this.latencyModel.estimate(wr.setId, deltaW);
            zone.wrPending[wr.setId] = { target: newW, writeTs: now, deltaW };
            if (estimatedMs > maxTimeoutMs) maxTimeoutMs = estimatedMs;

            this.log.debug(
                `[${zone.name}] [Latenz] ${wr.name}: ${Math.round(oldW)} → ${Math.round(newW)} W ` +
                `(δ${Math.round(deltaW)} W), Schätzung ${Math.round(estimatedMs)} ms`
            );
        }

        if (maxTimeoutMs > 0) {
            zone.waiting = true;
            zone.lockUntil = now + maxTimeoutMs;
        } else {
            zone.waiting = false;
            zone.lockUntil = 0;
        }

        // Neue Allokation für nächste Runde merken
        for (let i = 0; i < zone.inverters.length; i++) {
            zone.lastAlloc[zone.inverters[i].setId] = newAlloc[i];
        }
    }

    /**
     * Prüft für jeden WR in wrPending, ob sein Istwert das Ziel erreicht hat.
     * Sobald ein WR fertig ist, wird die Messung ins Modell eingetragen und er aus
     * wrPending entfernt. Wenn alle fertig sind, wird die Zonensperre aufgehoben.
     */
    checkLatencyReached(zone) {
        const tol = this.cfg.latencyToleranceW;
        let anyOpen = false;

        for (const [setId, p] of Object.entries(zone.wrPending)) {
            const wr = zone.inverters.find((w) => w.setId === setId);
            if (!wr) { delete zone.wrPending[setId]; continue; }

            const act = this.readNum(wr.actualId);
            if (act === null) { anyOpen = true; continue; }
            const actW = act * this.cfg.wrActualScale;

            if (Math.abs(actW - p.target) <= tol) {
                const measuredMs = this.now() - p.writeTs;
                this.latencyModel.record(setId, p.deltaW, measuredMs);
                this.log.debug(
                    `[${zone.name}] [Latenz] ${wr.name}: Ziel ${Math.round(p.target)} W erreicht ` +
                    `(Ist ${Math.round(actW)} W) nach ${Math.round(measuredMs)} ms`
                );
                delete zone.wrPending[setId];
            } else {
                anyOpen = true;
            }
        }

        if (!anyOpen) this.resetLatencyLock(zone);
    }

    // ---------- Wechselrichter-Liste ----------
    /**
     * Übernimmt die erkannte Wechselrichter-Liste einer Zone. list: [{ name, setId, actualId, maxW, enabled }]
     * initial = true: beim Start bestehende Sollwerte aktiver Wechselrichter übernehmen.
     */
    applyInverters(zoneName, list, initial = false) {
        const zone = this.zone(zoneName);
        if (!zone) return;
        const active = list.filter((w) => w.enabled);
        const structSig = JSON.stringify(list.map((w) => [w.name, w.setId, w.actualId, w.maxW]));
        const activeSig = active.map((w) => w.setId).join('|');
        const structChanged = structSig !== zone.structSig;
        const activeChanged = activeSig !== zone.activeSig;
        if (!structChanged && !activeChanged) return;

        const prevActive = zone.inverters;
        zone.structSig = structSig;
        zone.activeSig = activeSig;

        if (!zone.active) { // inaktive Zone: nur Liste merken, nichts schreiben
            zone.allInverters = list;
            zone.inverters = active;
            return;
        }
        if (initial) {
            zone.allInverters = list;
            zone.inverters = active;
            list.filter((w) => !w.enabled).forEach((w) => this.writeSet(w, 0)); // abgeschaltete sicher auf 0 W
            zone.lastTarget = active.reduce((a, wr) => a + (this.readNum(wr.setId) || 0), 0);
            zone.lastAlloc = {};
            for (const wr of active) zone.lastAlloc[wr.setId] = this.readNum(wr.setId) || 0;
        } else if (structChanged) {
            // Liste oder MaxW geändert: alles auf 0 W, Regelung startet neu
            this.deactivateFeedForward(zone, 'Wechselrichter-Liste geändert');
            const toZero = new Map();
            [...prevActive, ...list].forEach((w) => toZero.set(w.setId, w)); // auch bisher aktive, inzwischen entfernte
            toZero.forEach((w) => this.writeSet(w, 0));
            zone.allInverters = list;
            zone.inverters = active;
            zone.lastTarget = 0;
            zone.lastAlloc = {};
            this.resetLatencyLock(zone);
        } else {
            // Nur die Auswahl wurde geändert: laufende Wechselrichter bleiben unberührt
            const prevIds = new Set(prevActive.map((w) => w.setId));
            const nowIds = new Set(active.map((w) => w.setId));
            const keptSum = active.filter((w) => prevIds.has(w.setId)).reduce((a, w) => a + (this.readNum(w.setId) || 0), 0);
            prevActive.filter((w) => !nowIds.has(w.setId)).forEach((w) => this.writeSet(w, 0));
            active.filter((w) => !prevIds.has(w.setId)).forEach((w) => this.writeSet(w, 0));
            this.deactivateFeedForward(zone, 'Auswahl der Wechselrichter geändert');
            zone.allInverters = list;
            zone.inverters = active;
            zone.lastTarget = keptSum;
            // lastAlloc für die gebliebenen WR beibehalten, neue auf 0
            const newAlloc = {};
            for (const wr of active) newAlloc[wr.setId] = prevIds.has(wr.setId) ? (zone.lastAlloc[wr.setId] || 0) : 0;
            zone.lastAlloc = newAlloc;
            this.resetLatencyLock(zone);
        }
        const names = list.length ? list.map((w) => `${w.name}(${w.maxW} W)${w.enabled ? '' : ' AUS'}`).join(', ') : 'keine';
        this.log.info(`[${zone.name}] Wechselrichter (automatisch erkannt): ${names}`);
        if (!active.length) this.log.warn(`[${zone.name}] Keine aktiven Wechselrichter, Zone regelt nicht.`);
    }

    /** Startzustand nach erfolgreicher Prüfung der Pflicht-Datenpunkte. */
    start() {
        const soc = this.readNum(this.cfg.socId);
        this.isBatteryDisabled = soc === null || soc < this.cfg.socRestartPercent;
        this.configOk = true;
    }

    /** Gibt gelernte Latenzstatistiken für alle WR aller Zonen ins Log aus (stündlich). */
    logLatencyStats() {
        for (const zone of this.zones) {
            for (const wr of zone.allInverters) {
                const stats = this.latencyModel.stats(wr.setId);
                if (!stats.length) continue;
                const lines = stats.map((s) => `  ${s.bucket}: ${s.ewmaMs} ms (n=${s.n}${s.trusted ? '' : ', noch nicht zuverlässig'})`);
                this.log.info(`[${zone.name}] [Latenz] ${wr.name} gelernte Ansteuerungszeiten:\n${lines.join('\n')}`);
            }
        }
    }

    // ---------- Sicherheit und Datengültigkeit ----------
    /** Grund (String), wenn NICHT geregelt werden darf, sonst null. Betrifft alle Zonen. */
    checkGlobalBlocked() {
        const c = this.cfg;
        if (!this.enabled) return 'Hauptschalter aus';
        if (c.checkBmsOnline) {
            const o = this.io.get(c.bmsOnlineId);
            if (!o || !toBool(o.val)) return 'BMS offline';
        }
        if (c.checkBmsDischargeLimit) {
            const lim = this.readNum(c.bmsDischargeLimitId);
            if (lim === null || lim < c.minBmsDischargeLimitA) return `BMS-Entladelimit ${lim} A`;
        }
        if (c.checkBmsProtection) {
            const p = this.io.get(c.bmsProtectionId);
            if (p && toBool(p.val)) return 'BMS-Schutz aktiv';
        }
        const soc = this.readNum(c.socId);
        if (soc === null) return 'SoC ungültig';
        const restart = Math.max(c.socRestartPercent, c.socCutoffPercent); // Wiederfreigabe nie unter der Abschaltung
        if (soc <= c.socCutoffPercent) this.isBatteryDisabled = true;
        else if (this.isBatteryDisabled && soc >= restart) this.isBatteryDisabled = false;
        if (this.isBatteryDisabled) return `SoC ${soc} % (Wiederfreigabe ab ${restart} %)`;
        return null;
    }

    /** Prüfung je Zone (Wechselrichter, Zähler, Rückmeldung). */
    checkZoneBlocked(zone) {
        if (!zone.inverters.length) return 'keine aktiven Wechselrichter';
        const meter = this.io.get(zone.meterId);
        if (!meter || this.readNum(zone.meterId) === null) return 'Zählerwert ungültig';
        if (this.now() - meter.ts > this.cfg.maxMeterAgeS * 1000) return `Zählerwert älter als ${this.cfg.maxMeterAgeS} s`;
        if (this.wrActualTotal(zone) === null) return 'Wechselrichter-Rückmeldung ungültig';
        return null;
    }

    // ---------- Vorsteuerung (Feed-Forward) ----------
    deactivateFeedForward(zone, reason) {
        if (!zone.ff.active) return;
        this.log.info(`[${zone.name}] [Vorsteuerung] Modus beendet (${reason}).`);
        zone.ff.active = false;
        zone.ff.predicted = 0;
        zone.ff.lastPeakTs = 0;
    }

    feedForwardAbortReason(zone) {
        const c = this.cfg;
        const now = this.now();
        if (now - zone.ff.startTs > c.feedForwardMaxDurationS * 1000) return 'Maximaldauer erreicht';
        if (now - zone.ff.startTs >= c.feedForwardAbortWindowS * 1000) {
            const win = zone.history.filter((h) => now - h.t <= c.feedForwardAbortWindowS * 1000);
            if (win.length >= 5) {
                const mean = win.reduce((a, h) => a + h.v, 0) / win.length;
                if (mean < -c.feedForwardAbortExportW) return `mittlere Einspeisung ${Math.round(-mean)} W`;
            }
        }
        return null;
    }

    /** Neuer Zählerwert: Verlauf pflegen, getaktete Last erkennen, sofort regeln. */
    handleMeterUpdate(zone, state) {
        const c = this.cfg;
        if (!this.configOk || !zone.active || !state || state.val === null || state.val === undefined) return;
        const v = Number(state.val);
        if (!Number.isFinite(v)) return;

        const now = this.now();
        const recent = zone.history.filter((h) => now - h.t <= c.peakWindowMs);
        zone.history.push({ t: now, v });
        while (zone.history.length && now - zone.history[0].t > HISTORY_KEEP_MS) zone.history.shift();
        if (!c.feedForwardEnabled || !recent.length) return;

        const delta = v - Math.min(...recent.map((h) => h.v));
        if (delta < c.peakDetectionThresholdW || delta > c.peakMaxW) return;

        if (!zone.ff.active) {
            if (!zone.inverters.length) return;
            const base = this.wrActualTotal(zone);
            if (base === null) return;
            zone.ff.active = true;
            zone.ff.base = base;
            zone.ff.predicted = Math.round(delta * c.estimatedDutyCycle);
            zone.ff.startTs = now;
            this.log.info(`[${zone.name}] [Vorsteuerung] Getaktete Last erkannt (Sprung +${Math.round(delta)} W). Halte Ziel bei ${Math.round(base)} W + ${zone.ff.predicted} W.`);
        }
        zone.ff.lastPeakTs = now;
        this.runControlLoop(zone); // sofort regeln, Latenzsperre dieser Zone umgehen
    }

    /** Zeitüberschreitungen prüfen (alle ~500 ms aufrufen): Latenzsperre und Ende der Taktung. */
    housekeeping() {
        const now = this.now();
        for (const zone of this.activeZones()) {
            if (zone.waiting && now >= zone.lockUntil) {
                // Timeout: für alle noch offenen WR eine Messung mit der tatsächlichen Wartezeit eintragen
                for (const [setId, p] of Object.entries(zone.wrPending)) {
                    const timeoutMs = now - p.writeTs;
                    const wr = zone.inverters.find((w) => w.setId === setId);
                    const name = wr ? wr.name : setId;
                    this.log.warn(`[${zone.name}] [Latenz] ${name}: Timeout nach ${Math.round(timeoutMs / 1000)} s – Ziel ${Math.round(p.target)} W nicht erreicht`);
                    // Messung eintragen (latency-model verwirft zu hohe Werte automatisch)
                    this.latencyModel.record(setId, p.deltaW, timeoutMs);
                }
                this.resetLatencyLock(zone);
            }
            if (zone.ff.active && now - zone.ff.lastPeakTs > this.cfg.tactPauseTimeoutMs) {
                this.deactivateFeedForward(zone, `keine Taktung seit ${this.cfg.tactPauseTimeoutMs / 1000} s`);
                this.runControlLoop(zone);
            }
        }
    }

    // ---------- Budget ----------
    /** Max-Min-Fairness: Wünsche unterhalb des gleichen Anteils werden voll bedient, der Rest geteilt. */
    allocateBudget(freePlans, budget) {
        const sorted = freePlans.slice().sort((a, b) => a.desired - b.desired);
        let left = sorted.length;
        let remaining = Math.max(0, budget);
        for (const p of sorted) {
            p.alloc = Math.min(p.desired, remaining / left);
            remaining -= p.alloc;
            left--;
        }
    }

    // ---------- Regelschleife ----------
    /** forceZone: Zone, deren Latenzsperre umgangen wird (z. B. bei getakteter Last). */
    runControlLoop(forceZone = null) {
        if (!this.configOk) return;
        const c = this.cfg;
        const zones = this.activeZones();
        if (!zones.length) { this.publishGlobal(null); return; }

        // 1. Globale Sicherheit (Hauptschalter, BMS, SoC) -> alle Zonen auf 0 W
        const gBlocked = this.checkGlobalBlocked();
        if (gBlocked !== this.lastGlobalBlock) {
            if (gBlocked) this.log.warn(`Regelung gestoppt: ${gBlocked}. Alle Wechselrichter auf 0 W.`);
            else this.log.info('BMS/SoC-Bedingungen wieder erfüllt, Regelung läuft.');
            this.lastGlobalBlock = gBlocked;
        }
        if (gBlocked) {
            zones.forEach((z) => this.stopZone(z));
            this.publishAll(gBlocked);
            return;
        }

        // 2. Je Zone: Wunsch ermitteln oder Wert festhalten
        const plans = [];
        for (const zone of zones) {
            const zBlocked = this.checkZoneBlocked(zone);
            if (zBlocked !== zone.blockReason) {
                if (zBlocked) this.log.warn(`[${zone.name}] Regelung gestoppt: ${zBlocked}. Wechselrichter dieser Zone auf 0 W.`);
                else this.log.info(`[${zone.name}] Bedingungen wieder erfüllt, Regelung läuft.`);
                zone.blockReason = zBlocked;
            }
            if (zBlocked) {
                this.stopZone(zone);
                plans.push({ zone, fixed: true, value: 0 });
                continue;
            }
            const meter = this.readNum(zone.meterId);
            const wrActual = this.wrActualTotal(zone);

            if (zone === forceZone) {
                this.resetLatencyLock(zone);
            } else if (zone.waiting) {
                this.checkLatencyReached(zone);
                if (zone.waiting) { plans.push({ zone, fixed: true, value: zone.lastTarget }); continue; }
            }

            if (zone.ff.active) {
                const abort = this.feedForwardAbortReason(zone);
                if (abort) this.deactivateFeedForward(zone, abort);
            }

            let desired;
            if (zone.ff.active) desired = zone.ff.base + zone.ff.predicted; // Feed-Forward: konstant halten
            else if (Math.abs(meter) <= c.deadBandWatts) desired = zone.lastTarget; // im Totband: halten
            else desired = wrActual + meter;
            desired = Math.max(0, Math.min(desired, this.zoneMax(zone)));
            plans.push({ zone, fixed: false, desired, meter, wrActual });
        }

        // 3. Gemeinsames BMS-Budget verteilen
        const fixedSum = plans.filter((p) => p.fixed).reduce((a, p) => a + p.value, 0);
        const freePlans = plans.filter((p) => !p.fixed);
        this.allocateBudget(freePlans, c.totalBmsLimitW - fixedSum);

        // Totband je Zone: kleine Änderungen nicht senden
        for (const p of freePlans) p.skip = Math.abs(p.alloc - p.zone.lastTarget) <= c.deadBandWatts;
        // Gesamtlimit strikt einhalten: übersprungene Zone über ihrer Zuteilung wird trotz Totband heruntergeregelt
        const projected = () => plans.reduce((a, p) => a + (p.fixed ? p.value : (p.skip ? p.zone.lastTarget : p.alloc)), 0);
        if (projected() > c.totalBmsLimitW) {
            for (const p of freePlans) if (p.skip && p.zone.lastTarget > p.alloc) p.skip = false;
        }

        // 4. Verteilen und senden
        for (const p of freePlans) {
            if (p.skip) continue;
            const zone = p.zone;
            const alloc = this.distribute(zone, p.alloc);
            const sent = alloc.reduce((a, b) => a + b, 0);
            const limited = p.alloc < p.desired - 0.5 ? ` | BMS-Budget begrenzt (Wunsch ${Math.round(p.desired)} W)` : '';
            const line = `[${zone.name}] SoC ${this.readNum(c.socId)} % | Zähler ${Math.round(p.meter)} W | WR-Ist ${Math.round(p.wrActual)} W | ${zone.ff.active ? 'Vorsteuerung | ' : ''}Soll ${sent} W (${alloc.join('/')} W)${limited}`;
            if (c.regulationLogLevel === 'info') this.log.info(line); else this.log.debug(line);
            // Latenzsperre per WR starten (muss VOR zone.lastTarget-Zuweisung passieren,
            // damit startLatencyLock die alte Allokation korrekt aus zone.lastAlloc liest)
            this.startLatencyLock(zone, alloc, sent);
            this.setAll(zone, alloc);
            zone.lastTarget = sent;
        }
        this.publishAll(null);
    }

    // ---------- Ausgaben ----------
    publishGlobal(gBlocked) {
        const p = this.io.publish;
        p('Gesperrt', gBlocked || '');
        p('Akku_Gesperrt', this.isBatteryDisabled);
        p('info.connection', false);
    }

    publishAll(gBlocked) {
        const p = this.io.publish;
        p('Gesperrt', gBlocked || '');
        p('Akku_Gesperrt', this.isBatteryDisabled);
        let running = false;
        for (const z of this.activeZones()) {
            const m = this.readNum(z.meterId);
            if (m !== null) p(`${z.name}.Zaehler_W`, Math.round(m));
            const a = this.wrActualTotal(z);
            if (a !== null) p(`${z.name}.Ist_W`, Math.round(a));
            p(`${z.name}.Soll_W`, Math.round(z.lastTarget));
            const reason = gBlocked ? gBlocked : (z.blockReason || '');
            p(`${z.name}.Gesperrt`, reason);
            p(`${z.name}.Vorsteuerung`, z.ff.active);
            if (!gBlocked && !z.blockReason) running = true;
        }
        p('info.connection', running);
    }

    /** Beim Stoppen alle aktiven Wechselrichter auf 0 W (zeroOnStop). */
    shutdown() {
        if (!this.cfg.zeroOnStop || !this.configOk || this.cfg.dryRun) return Promise.resolve();
        return Promise.all(this.activeZones().map((z) => this.setAll(z, z.inverters.map(() => 0))));
    }
}

module.exports = { NulleinspeisungCore };
