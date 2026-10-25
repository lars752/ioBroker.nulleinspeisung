'use strict';

/**
 * Sitzungsinternes Lernmodell für WR-Ansteuerungszeiten.
 *
 * Die gemessene Latenz (Zeit vom Sollwert-Schreiben bis der WR das Ziel erreicht hat) wird
 * in 10-W-Buckets je Zonenname gespeichert. Pro Bucket läuft ein exponentiell gewichteter
 * gleitender Mittelwert (EWMA), sodass neuere Messungen stärker gewichtet werden als ältere.
 *
 * Bis ein Bucket mindestens MIN_SAMPLES Messungen hat, gilt der konfigurierte Fallback-Timeout.
 *
 * Öffentliche API:
 *   model.record(zoneName, deltaW, measuredMs)  → Messung eintragen
 *   model.estimate(zoneName, deltaW)             → geschätzte Latenz in ms (oder Fallback)
 *   model.stats(zoneName)                        → lesbares Objekt für Log/Debug
 */

const BUCKET_W        = 10;    // Bucketbreite in Watt
const EWMA_ALPHA      = 0.25;  // Lernrate: 0.25 → ~75 % Gewicht auf ältere Werte, 25 % auf neue
const MIN_SAMPLES     = 3;     // Mindest-Messungen, bevor ein Bucket als zuverlässig gilt
const MAX_LATENCY_MS  = 30000; // Messungen über diesem Wert werden verworfen (vermutlich Rauschen)
const MIN_LATENCY_MS  = 200;   // darunter gilt als nicht aussagekräftig (Messartefakt)

class LatencyModel {
    /**
     * @param {number} fallbackMs  Timeout aus der Konfiguration (maxLatencyTimeoutS * 1000);
     *                             wird zurückgegeben, solange kein Bucket ausreichend befüllt ist.
     * @param {object} log         ioBroker-Log-Objekt (debug/info/warn)
     */
    constructor(fallbackMs, log) {
        this.fallbackMs = fallbackMs;
        this.log        = log;
        // { [zoneName]: Map<bucketIndex, { ewma: number, n: number }> }
        this._zones = {};
    }

    // ── interne Helfer ────────────────────────────────────────────────────────

    _bucketOf(deltaW) {
        // Negativer oder Null-Delta: Bucket 0 (Verringerung / kein Schritt)
        return Math.max(0, Math.floor(Math.abs(deltaW) / BUCKET_W));
    }

    _zoneMap(zoneName) {
        if (!this._zones[zoneName]) this._zones[zoneName] = new Map();
        return this._zones[zoneName];
    }

    // ── öffentliche API ───────────────────────────────────────────────────────

    /**
     * Messung eintragen.
     * @param {string} zoneName   z. B. "wohnung_links"
     * @param {number} deltaW     Betrag der Sollwertänderung in W (>= 0)
     * @param {number} measuredMs tatsächlich gemessene Latenz in ms
     */
    record(zoneName, deltaW, measuredMs) {
        if (!Number.isFinite(measuredMs) || measuredMs < MIN_LATENCY_MS || measuredMs > MAX_LATENCY_MS) {
            this.log.debug(`[LatencyModel][${zoneName}] Messung ${Math.round(measuredMs)} ms verworfen (außerhalb [${MIN_LATENCY_MS}, ${MAX_LATENCY_MS}] ms)`);
            return;
        }
        const bucket = this._bucketOf(deltaW);
        const map    = this._zoneMap(zoneName);
        const entry  = map.get(bucket);
        if (!entry) {
            map.set(bucket, { ewma: measuredMs, n: 1 });
        } else {
            entry.ewma = EWMA_ALPHA * measuredMs + (1 - EWMA_ALPHA) * entry.ewma;
            entry.n   += 1;
        }
        this.log.debug(
            `[LatencyModel][${zoneName}] δ${Math.round(deltaW)} W → ` +
            `Bucket ${bucket * BUCKET_W}–${(bucket + 1) * BUCKET_W} W: ` +
            `${Math.round(measuredMs)} ms gemessen, EWMA jetzt ${Math.round(map.get(bucket).ewma)} ms ` +
            `(n=${map.get(bucket).n})`
        );
    }

    /**
     * Geschätzte Latenz zurückgeben.
     *
     * Strategie: exakten Bucket prüfen, dann interpolieren (nächster befüllter Bucket
     * ober- und unterhalb), sonst Fallback.
     *
     * @param {string} zoneName
     * @param {number} deltaW   Betrag der Sollwertänderung in W
     * @returns {number}        Latenz in ms
     */
    estimate(zoneName, deltaW) {
        const map    = this._zones[zoneName];
        if (!map || !map.size) return this.fallbackMs;

        const target = this._bucketOf(deltaW);

        // 1. Exakter Bucket
        const exact = map.get(target);
        if (exact && exact.n >= MIN_SAMPLES) return Math.round(exact.ewma);

        // 2. Interpolation: je einen befüllten Bucket ober- und unterhalb suchen
        let lo = null, hi = null;
        for (const [idx, entry] of map.entries()) {
            if (entry.n < MIN_SAMPLES) continue;
            if (idx <= target && (lo === null || idx > lo[0])) lo = [idx, entry.ewma];
            if (idx >= target && (hi === null || idx < hi[0])) hi = [idx, entry.ewma];
        }
        if (lo && hi && lo[0] !== hi[0]) {
            const t = (target - lo[0]) / (hi[0] - lo[0]);
            return Math.round(lo[1] + t * (hi[1] - lo[1]));
        }
        if (lo) return Math.round(lo[1]);
        if (hi) return Math.round(hi[1]);

        // 3. Fallback
        return this.fallbackMs;
    }

    /**
     * Lesbares Statistik-Objekt für Logging.
     * @param {string} zoneName
     * @returns {{ bucket: string, ewmaMs: number, n: number }[]}
     */
    stats(zoneName) {
        const map = this._zones[zoneName];
        if (!map) return [];
        return [...map.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([idx, e]) => ({
                bucket : `${idx * BUCKET_W}–${(idx + 1) * BUCKET_W} W`,
                ewmaMs : Math.round(e.ewma),
                n      : e.n,
                trusted: e.n >= MIN_SAMPLES,
            }));
    }
}

module.exports = { LatencyModel, BUCKET_W, MIN_SAMPLES };
