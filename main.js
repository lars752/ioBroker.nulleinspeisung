'use strict';
const utils = require('@iobroker/adapter-core');
const { normalizeConfig, validateTunable, TUNABLE } = require('./lib/model');
const { NulleinspeisungCore } = require('./lib/core');
const configio = require('./lib/configio');

const KEEP = new Set(['info', 'info.connection', 'Aktiv', 'Gesperrt', 'Akku_Gesperrt']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const naturalSort = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true });

const ZONE_STATES = [
    ['Zaehler_W', 'Zählerwert (Bezug +, Einspeisung −)', 'number', 'value.power', 'W', 0],
    ['Ist_W', 'Summe der Wechselrichter-Ausgangsleistung', 'number', 'value.power', 'W', 0],
    ['Soll_W', 'Aktuell vorgegebene Gesamt-Sollleistung', 'number', 'value.power', 'W', 0],
    ['Gesperrt', 'Grund der Sperre (leer = Regelung läuft)', 'string', 'text', '', ''],
    ['Vorsteuerung', 'Vorsteuerung für getaktete Last aktiv', 'boolean', 'indicator', '', false],
];

class Nulleinspeisung extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'nulleinspeisung' });
        this.cache = new Map();   // eigene Zustände (zuletzt geschriebener Wert)
        this.fcache = new Map();  // Fremdzustände { val, ts }
        this.watched = new Set();
        this.chains = new Map();  // Aktualisierung der Wechselrichter-Liste je Zone (seriell)
        this.queue = Promise.resolve();
        this.core = null;
        this.lastMissing = '';
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /** Schreibt geänderte Werte nacheinander in den Namensraum der Instanz (nulleinspeisung.<N>). */
    write(id, val) {
        this.queue = this.queue
            .then(async () => {
                if (this.cache.get(id) === val) return;
                this.cache.set(id, val);
                await this.setStateAsync(id, { val, ack: true });
            })
            .catch((e) => this.log.error(`Schreiben von ${id} fehlgeschlagen: ${e.message}`));
        return this.queue;
    }

    async ensureState(id, common, defaultValue) {
        await this.extendObjectAsync(id, { type: 'state', common, native: {} });
        const cur = await this.getStateAsync(id);
        if (!cur || cur.val === null) await this.setStateAsync(id, { val: defaultValue, ack: true });
    }

    async ensureStructure(zones) {
        const names = new Set(zones.map((z) => z.name));
        for (const z of zones) {
            await this.extendObjectAsync(z.name, { type: 'channel', common: { name: `Zone ${z.name}` }, native: {} });
            for (const [id, name, type, role, unit, def] of ZONE_STATES) {
                const common = { name: `${z.name}: ${name}`, type, role, read: true, write: false, def };
                if (unit) common.unit = unit;
                await this.ensureState(`${z.name}.${id}`, common, def);
            }
        }
        const all = await this.getAdapterObjectsAsync();
        for (const full of Object.keys(all)) {
            const rel = full.slice(this.namespace.length + 1);
            if (!rel || KEEP.has(rel) || rel.startsWith('info.') || names.has(rel.split('.')[0])) continue;
            await this.delObjectAsync(rel);
            this.log.info(`Veralteten Datenpunkt entfernt: ${rel}`);
        }
    }

    /** Abonniert Fremd-Datenpunkte und füllt den Zwischenspeicher. */
    async ensureWatched(ids) {
        for (const id of ids) {
            if (this.watched.has(id)) continue;
            this.watched.add(id);
            this.subscribeForeignStates(id);
            const st = await this.getForeignStateAsync(id);
            if (st) this.fcache.set(id, { val: st.val, ts: st.ts });
        }
    }

    async syncWatched() {
        const want = this.core.watchedIds();
        for (const id of [...this.watched]) {
            if (!want.has(id)) {
                this.unsubscribeForeignStates(id);
                this.fcache.delete(id);
                this.watched.delete(id);
            }
        }
        await this.ensureWatched(want);
    }

    /** Erkennt die Wechselrichter einer Zone (<Gruppe>.WR<x>.Power mit zugehörigem InvOutputWatts) und liest Aktiv/MaxW aus der Config (wrConfig) oder Laufzeit-Datenpunkten. */
    async discoverInverters(zone) {
        const re = new RegExp(`^${esc(zone.groupPath)}\\.(WR[^.]*)\\.Power$`);
        const objs = (await this.getForeignObjectsAsync(`${zone.groupPath}.*`, 'state')) || {};
        const list = [];
        for (const id of Object.keys(objs)) {
            const m = re.exec(id);
            if (!m) continue;
            const actualId = `${zone.groupPath}.${m[1]}.InvOutputWatts`;
            if (!objs[actualId]) { this.log.warn(`[${zone.name}] ${m[1]}: Istwert ${actualId} fehlt – übersprungen`); continue; }
            list.push({ name: m[1], setId: id, actualId });
        }
        list.sort(naturalSort);
        // wrConfig aus Admin-Konfiguration (falls vorhanden)
        const wrConfigArr = Array.isArray(this.config.wrConfig) ? this.config.wrConfig : [];
        for (const wr of list) {
            const base = `${zone.name}.${wr.name}`;
            // Config-Eintrag für diesen WR suchen
            const cfgEntry = wrConfigArr.find((e) => e.zone === zone.name && e.name === wr.name);
            await this.extendObjectAsync(base, { type: 'channel', common: { name: `${zone.name} ${wr.name}` }, native: {} });
            await this.ensureState(`${base}.Aktiv`, { name: `${base}: Wechselrichter an der Regelung beteiligt`, type: 'boolean', role: 'switch', read: true, write: true, def: this.core.cfg.wrSwitchDefault }, this.core.cfg.wrSwitchDefault);
            await this.ensureState(`${base}.MaxW`, { name: `${base}: Maximalleistung (0 = Standard)`, type: 'number', unit: 'W', role: 'level', read: true, write: true, def: 0 }, 0);
            if (cfgEntry !== undefined) {
                // Config hat Vorrang vor Laufzeit-Datenpunkt
                const cfgEnabled = cfgEntry.enabled !== false && cfgEntry.enabled !== 'false' && cfgEntry.enabled !== 0;
                const cfgMaxW = Number(cfgEntry.maxW) > 0 ? Number(cfgEntry.maxW) : this.core.cfg.wrDefaultMaxW;
                wr.enabled = cfgEnabled;
                wr.maxW = cfgMaxW;
                // Datenpunkte mit Config-Wert synchronisieren
                await this.setStateAsync(`${base}.Aktiv`, { val: cfgEnabled, ack: true });
                await this.setStateAsync(`${base}.MaxW`, { val: cfgEntry.maxW > 0 ? Number(cfgEntry.maxW) : 0, ack: true });
            } else {
                // Fallback: Laufzeit-Datenpunkte lesen
                const sw = await this.getStateAsync(`${base}.Aktiv`);
                const mx = await this.getStateAsync(`${base}.MaxW`);
                const maxW = mx && Number(mx.val) > 0 ? Number(mx.val) : this.core.cfg.wrDefaultMaxW;
                wr.enabled = !(sw && (sw.val === false || sw.val === 'false' || sw.val === 0));
                wr.maxW = maxW;
            }
        }
        return list;
    }

    refreshZone(name, initial = false) {
        const next = (this.chains.get(name) || Promise.resolve())
            .then(async () => {
                const list = await this.discoverInverters(this.core.zone(name));
                await this.ensureWatched(list.flatMap((w) => [w.setId, w.actualId]));
                this.core.applyInverters(name, list, initial);
                await this.syncWatched();
            })
            .catch((e) => this.log.error(`[${name}] Wechselrichter-Erkennung: ${e.message}`));
        this.chains.set(name, next);
        return next;
    }

    /** Prüft die Pflicht-Datenpunkte; bei Erfolg Start der Regelung. Wird bei Fehlern jede Rescan-Runde wiederholt. */
    async tryInit() {
        const missing = [];
        for (const [label, id] of this.core.requiredIds()) if (!(await this.getForeignObjectAsync(id))) missing.push(`${label} (${id})`);
        if (missing.length) {
            const msg = missing.join(', ');
            if (msg !== this.lastMissing) this.log.error(`Pflicht-Datenpunkte fehlen: ${msg}. Es wird nicht geregelt, die Prüfung wird regelmäßig wiederholt`);
            this.lastMissing = msg;
            return false;
        }
        this.lastMissing = '';
        await this.syncWatched();
        for (const z of this.core.zones) await this.refreshZone(z.name, true);
        this.core.start();
        this.log.info('Pflicht-Datenpunkte vorhanden, Regelung gestartet');
        this.core.runControlLoop();
        return true;
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        const { cfg, errors } = normalizeConfig(this.config, this.log);
        if (errors.length) {
            for (const e of errors) this.log.error(e);
            this.log.error('Konfiguration fehlerhaft – es wird nicht geregelt. Bitte in der Instanz korrigieren');
            return;
        }
        if (!cfg.zones.length) this.log.warn('Keine Zonen konfiguriert – bitte die Zonentabelle in der Instanz ausfüllen');
        else if (!cfg.zones.some((z) => z.active)) this.log.warn('Keine Zone aktiv – bitte in der Zonentabelle mindestens eine Zone aktivieren');
        if (cfg.dryRun) this.log.warn('TESTLAUF aktiv: Es werden keine Sollwerte geschrieben');

        await this.ensureStructure(cfg.zones);
        const aktiv = await this.getStateAsync('Aktiv');
        if (!aktiv || aktiv.val === null) await this.setStateAsync('Aktiv', { val: true, ack: true });
        this.core = new NulleinspeisungCore({
            cfg,
            log: this.log,
            enabled: !aktiv || aktiv.val !== false,
            io: {
                get: (id) => this.fcache.get(id),
                setSetpoint: (id, val) => {
                    this.fcache.set(id, { val, ts: Date.now() });
                    return this.setForeignStateAsync(id, { val, ack: false }).catch((e) => this.log.error(`Sollwert ${id}: ${e.message}`));
                },
                publish: (id, val) => this.write(id, val),
            },
        });
        this.subscribeStates('*');
        await this.tryInit();

        const guard = (fn) => () => { try { fn(); } catch (e) { this.log.error(`Regelung: ${e.message}`); } };
        this.loopTimer = setInterval(guard(() => this.core.runControlLoop()), cfg.regulatorIntervalMs);
        this.housekeepingTimer = setInterval(guard(() => this.core.housekeeping()), 500);
        this.latencyStatsTimer = setInterval(guard(() => this.core.logLatencyStats()), 60 * 60 * 1000); // stündlich
        this.rescanTimer = setInterval(() => {
            const job = this.core.configOk ? Promise.all(this.core.zones.map((z) => this.refreshZone(z.name, false))) : this.tryInit();
            job.catch((e) => this.log.error(`Rescan: ${e.message}`));
        }, cfg.rescanS * 1000);
        this.log.info(`Adapter gestartet, Zonen: ${cfg.zones.map((z) => `${z.name}${z.active ? '' : ' (inaktiv)'}`).join(', ') || '(keine)'}`);
    }

    onStateChange(id, state) {
        if (!this.core || !state) return;
        const prefix = `${this.namespace}.`;
        if (id.startsWith(prefix)) {
            if (state.ack !== false) return;
            const rel = id.slice(prefix.length);
            if (rel === 'Aktiv') {
                this.core.enabled = state.val !== false && state.val !== 'false' && state.val !== 0;
                this.log.info(`Hauptschalter: ${this.core.enabled ? 'aktiv' : 'AUS – alle Wechselrichter auf 0 W'}`);
                this.setState('Aktiv', { val: this.core.enabled, ack: true });
                try { this.core.runControlLoop(); } catch (e) { this.log.error(e.message); }
            } else if (/^[^.]+\.WR[^.]*\.(Aktiv|MaxW)$/.test(rel) && this.core.zone(rel.split('.')[0])) {
                this.refreshZone(rel.split('.')[0], false).then(() => this.setState(rel, { val: state.val, ack: true }));
            }
            return;
        }
        if (!this.watched.has(id)) return;
        this.fcache.set(id, { val: state.val, ts: state.ts });
        const zone = this.core.zoneByMeter(id);
        if (zone) {
            try { this.core.handleMeterUpdate(zone, state); } catch (e) { this.log.error(`Zählerwert ${id}: ${e.message}`); }
        }
    }

    /** Übernimmt geprüfte Laufzeitwerte in die aktive Kern-Konfiguration. */
    _applyRuntimeConfig(applied) {
        const cfg = this.core.cfg;
        Object.assign(cfg, applied);
        if ('maxLatencyTimeoutS' in applied) this.core.latencyModel.fallbackMs = cfg.maxLatencyTimeoutS * 1000;
        if ('regulatorIntervalMs' in applied) {
            clearInterval(this.loopTimer);
            this.loopTimer = setInterval(() => {
                try { this.core.runControlLoop(); } catch (e) { this.log.error(`Regelung: ${e.message}`); }
            }, cfg.regulatorIntervalMs);
        }
        if ('socCutoffPercent' in applied || 'socRestartPercent' in applied) {
            this.log.info(`Akkuschutz: Abschaltung bei ${cfg.socCutoffPercent} %, Wiederfreigabe ab ${cfg.socRestartPercent} %`);
        }
    }

    /** Nachrichten der Admin-Oberfläche: JSON-Export/-Import und WR-Scan. */
    onMessage(obj) {
        if (!obj || !obj.command || !obj.callback) return;
        if (obj.command === 'scanInverters') {
            this._handleScanInverters(obj.message || {})
                .then((reply) => this.sendTo(obj.from, obj.command, { native: reply }, obj.callback))
                .catch((e) => this.sendTo(obj.from, obj.command, { error: `Fehler: ${e.message}` }, obj.callback));
            return;
        }
        // Agent-API: Parameter zur Laufzeit lesen / schreiben (kein Neustart nötig, nicht persistent)
        if (obj.command === 'getConfig') {
            const src = this.core ? this.core.cfg : this.config;
            const safe = {};
            for (const key of TUNABLE) if (key in src) safe[key] = src[key];
            this.sendTo(obj.from, obj.command, safe, obj.callback);
            return;
        }
        if (obj.command === 'setConfig') {
            if (!this.core) { this.sendTo(obj.from, obj.command, { error: 'Regelung noch nicht gestartet' }, obj.callback); return; }
            const { applied, rejected } = validateTunable(obj.message || {}, this.core.cfg);
            this._applyRuntimeConfig(applied);
            this.log.info(`[setConfig] Angepasst: ${JSON.stringify(applied)}${Object.keys(rejected).length ? ` | Abgelehnt: ${JSON.stringify(rejected)}` : ''}`);
            this.sendTo(obj.from, obj.command, { applied, rejected }, obj.callback);
            return;
        }

        let reply;
        try {
            const msg = obj.message || {};
            if (obj.command === 'exportConfig') reply = configio.exportConfig(msg.config);
            else if (obj.command === 'importConfig') reply = configio.importConfig(msg.json);
            else return;
        } catch (e) {
            reply = { error: `Fehler: ${e.message}` };
        }
        this.sendTo(obj.from, obj.command, reply, obj.callback);
    }

    /** Scannt alle Gruppen nach WR<x>.Power und gibt die gefundenen WRs als wrConfig-Array zurück. */
    async _handleScanInverters(msg) {
        const zones = Array.isArray(msg.zones) ? msg.zones : [];
        const existing = Array.isArray(msg.wrConfig) ? msg.wrConfig : [];
        const result = [];
        for (const zone of zones) {
            if (!zone.name || !zone.groupPath) continue;
            const re = new RegExp(`^${esc(zone.groupPath)}\\.(WR[^.]*)\\.Power$`);
            let objs = {};
            try { objs = (await this.getForeignObjectsAsync(`${zone.groupPath}.*`, 'state')) || {}; } catch (e) { /* ignore */ }
            const found = [];
            for (const id of Object.keys(objs)) {
                const m = re.exec(id);
                if (!m) continue;
                const actualId = `${zone.groupPath}.${m[1]}.InvOutputWatts`;
                if (!objs[actualId]) continue;
                found.push({ name: m[1], setId: id });
            }
            found.sort(naturalSort);
            for (const wr of found) {
                // Bestehende Einstellungen übernehmen
                const prev = existing.find((e) => e.zone === zone.name && e.name === wr.name);
                result.push({
                    zone: zone.name,
                    name: wr.name,
                    enabled: prev ? prev.enabled !== false && prev.enabled !== 'false' && prev.enabled !== 0 : true,
                    maxW: prev ? (Number(prev.maxW) || 0) : 0,
                    setId: wr.setId,
                });
            }
        }
        return { wrConfig: result };
    }

    onUnload(callback) {
        for (const t of [this.loopTimer, this.housekeepingTimer, this.latencyStatsTimer, this.rescanTimer]) if (t) clearInterval(t);
        const done = () => {
            try { this.setState('info.connection', false, true); } finally { callback(); }
        };
        if (!this.core) return done();
        // Sicherheit: beim Stoppen alle aktiven Wechselrichter auf 0 W (zeroOnStop), höchstens 2 s warten
        return Promise.race([this.core.shutdown(), new Promise((r) => setTimeout(r, 2000))]).then(done, done);
    }
}

if (require.main !== module) module.exports = (options) => new Nulleinspeisung(options);
else new Nulleinspeisung();
