'use strict';
/**
 * Konfigurationsprüfung: globale Parameter und Zonen (Wohnungen).
 * Reine Logik ohne ioBroker-Abhängigkeit (testbar).
 */
const SEG = /^[A-Za-z0-9_-]+$/;
const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

// [Schlüssel, Typ, Standardwert, min, max] bzw. [Schlüssel, 'enum', Standardwert, erlaubte Werte]
const PARAMS = [
    ['socId', 'id', 'growatt-bms.0.SoC'],
    ['bmsOnlineId', 'id', 'growatt-bms.0.Online'],
    ['bmsDischargeLimitId', 'id', 'growatt-bms.0.Discharge_Current_Limit'],
    ['bmsProtectionId', 'id', 'growatt-bms.0.Any_Protection'],
    ['checkBmsOnline', 'bool', true],
    ['checkBmsDischargeLimit', 'bool', true],
    ['checkBmsProtection', 'bool', true],
    ['minBmsDischargeLimitA', 'num', 1, 0, 10000],
    ['socCutoffPercent', 'num', 20, 0, 100],
    ['socRestartPercent', 'num', 23, 0, 100],
    ['totalBmsLimitW', 'num', 3000, 0, 1000000],
    ['wrSwitchDefault', 'bool', true],
    ['wrDefaultMaxW', 'num', 800, 1, 100000],
    ['rescanS', 'num', 60, 5, 86400],
    ['wrActualScale', 'num', 1, 0.0001, 1000000],
    ['latencyToleranceW', 'num', 40, 0, 100000],
    ['maxLatencyTimeoutS', 'num', 10, 1, 3600],
    ['deadBandWatts', 'num', 15, 0, 10000],
    ['regulatorIntervalMs', 'num', 3000, 500, 60000],
    ['maxMeterAgeS', 'num', 15, 1, 3600],
    ['zeroOnStop', 'bool', true],
    ['regulationLogLevel', 'enum', 'debug', ['info', 'debug']],
    ['dryRun', 'bool', false],
    ['feedForwardEnabled', 'bool', true],
    ['peakDetectionThresholdW', 'num', 1200, 1, 100000],
    ['peakMaxW', 'num', 2500, 1, 100000],
    ['peakWindowMs', 'num', 2000, 100, 20000],
    ['estimatedDutyCycle', 'num', 0.5, 0, 1],
    ['tactPauseTimeoutMs', 'num', 3500, 500, 600000],
    ['feedForwardMaxDurationS', 'num', 180, 1, 86400],
    ['feedForwardAbortWindowS', 'num', 12, 1, 20],
    ['feedForwardAbortExportW', 'num', 250, 0, 100000],
];

const DEFAULTS = { ...Object.fromEntries(PARAMS.map((p) => [p[0], p[2]])), zones: [] };
const ZONE_DEFAULTS = { active: false, maxW: 2000 };
const KEYS = PARAMS.map((p) => p[0]);

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const isBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** Prüft die komplette Konfiguration. Fehler in globalen Werten -> errors; ungültige Zonenzeilen -> Warnung + übersprungen. */
function normalizeConfig(native, log = silent) {
    const n = native || {};
    const errors = [];
    const warnings = [];
    const warn = (m) => { warnings.push(m); log.warn(m); };
    const cfg = {};

    for (const [key, type, def, a, b] of PARAMS) {
        const raw = n[key] === undefined || n[key] === null ? def : n[key];
        if (type === 'bool') { cfg[key] = n[key] === undefined ? def : isBool(raw); continue; }
        if (type === 'enum') {
            if (!a.includes(raw)) { errors.push(`${key} „${raw}“ ungültig (erlaubt: ${a.join(', ')})`); cfg[key] = def; } else cfg[key] = raw;
            continue;
        }
        if (type === 'id') { cfg[key] = String(raw).trim(); continue; } // Prüfung unten (hängt von den Schaltern ab)
        const v = n[key] === '' ? NaN : Number(raw);
        if (!Number.isFinite(v) || v < a || v > b) { errors.push(`${key} muss zwischen ${a} und ${b} liegen (ist: ${raw})`); cfg[key] = def; } else cfg[key] = v;
    }
    const idRule = [['socId', true, 'Datenpunkt des Akku-SoC'], ['bmsOnlineId', cfg.checkBmsOnline, 'BMS-Online-Datenpunkt'], ['bmsDischargeLimitId', cfg.checkBmsDischargeLimit, 'BMS-Entladelimit-Datenpunkt'], ['bmsProtectionId', cfg.checkBmsProtection, 'BMS-Schutz-Datenpunkt']];
    for (const [key, required, label] of idRule) {
        if (!cfg[key] && !required) continue;
        if (!PATH.test(cfg[key])) errors.push(`${label} „${cfg[key]}“ ist ungültig (erlaubt: A-Z, 0-9, _, -, Punkt als Trenner)`);
    }
    if (cfg.peakDetectionThresholdW >= cfg.peakMaxW) errors.push(`peakDetectionThresholdW (${cfg.peakDetectionThresholdW}) muss kleiner als peakMaxW (${cfg.peakMaxW}) sein`);

    cfg.zones = [];
    const names = new Set();
    const groups = new Set();
    const meters = new Set();
    for (const [i, row] of (Array.isArray(n.zones) ? n.zones : []).entries()) {
        const where = `Zone, Zeile ${i + 1}`;
        const name = String((row && row.name) || '').trim();
        if (!name && !(row && (row.meterId || row.groupPath))) continue;
        if (!SEG.test(name) || ['info', 'aktiv', 'gesperrt'].includes(name.toLowerCase())) { warn(`${where}: Name „${name}“ ungültig (erlaubt: A-Z, 0-9, _, -; „info“, „Aktiv“, „Gesperrt“ sind reserviert) – übersprungen`); continue; }
        const meterId = String(row.meterId || '').trim();
        const groupPath = String(row.groupPath || '').trim();
        if (!PATH.test(meterId)) { warn(`${where} (${name}): Zähler-Datenpunkt „${meterId}“ ungültig – übersprungen`); continue; }
        if (!PATH.test(groupPath)) { warn(`${where} (${name}): Wechselrichter-Gruppe „${groupPath}“ ungültig – übersprungen`); continue; }
        const maxW = row.maxW === undefined || row.maxW === '' ? ZONE_DEFAULTS.maxW : Number(row.maxW);
        if (!Number.isFinite(maxW) || maxW < 1 || maxW > 100000) { warn(`${where} (${name}): Maximalleistung muss zwischen 1 und 100000 W liegen – übersprungen`); continue; }
        if (names.has(name)) { warn(`${where}: Name ${name} doppelt – übersprungen`); continue; }
        if (groups.has(groupPath)) { warn(`${where} (${name}): Wechselrichter-Gruppe ${groupPath} ist schon einer anderen Zone zugeordnet – übersprungen`); continue; }
        if (meters.has(meterId)) { warn(`${where} (${name}): Zähler ${meterId} ist schon einer anderen Zone zugeordnet – übersprungen`); continue; }
        names.add(name); groups.add(groupPath); meters.add(meterId);
        cfg.zones.push({ name, active: isBool(row.active), meterId, groupPath, maxW });
    }
    return { cfg, errors, warnings };
}

const rowsOf = (zones) => zones.map((z) => ({ name: z.name, active: z.active, meterId: z.meterId, groupPath: z.groupPath, maxW: z.maxW }));

module.exports = { PARAMS, KEYS, DEFAULTS, ZONE_DEFAULTS, normalizeConfig, rowsOf };
