'use strict';
const assert = require('assert');
const { normalizeConfig, DEFAULTS } = require('../lib/model');
const { NulleinspeisungCore } = require('../lib/core');
const { exportConfig, importConfig } = require('../lib/configio');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const logs = { info: [], warn: [], debug: [] };
const log = { debug: (m) => logs.debug.push(m), info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error() {} };
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const reset = () => { logs.info.length = 0; logs.warn.length = 0; logs.debug.length = 0; };

const BMS = { soc: 'bms.0.SoC', online: 'bms.0.Online', limit: 'bms.0.Discharge_Current_Limit', prot: 'bms.0.Any_Protection' };
const SET = (g, w) => `g.${g}.${w}.Power`;
const ACT = (g, w) => `g.${g}.${w}.InvOutputWatts`;
const METER = (z) => `m.${z}`;
const zoneRow = (name, extra = {}) => ({ name, active: true, meterId: METER(name), groupPath: `g.${name}`, maxW: 2000, ...extra });

/** Baut Kern und simulierte Umgebung (zwei Zonen, je zwei Wechselrichter à 1000 W). */
function mk(over = {}, zoneExtra = {}, { init = true } = {}) {
    const t = { now: 50_000_000 };
    const states = new Map();
    const writes = [];
    const pub = {};
    const put = (id, val, ts) => states.set(id, { val, ts: ts === undefined ? t.now : ts });
    const { cfg, errors } = normalizeConfig({
        socId: BMS.soc, bmsOnlineId: BMS.online, bmsDischargeLimitId: BMS.limit, bmsProtectionId: BMS.prot,
        wrDefaultMaxW: 1000, zones: [zoneRow('links', zoneExtra), zoneRow('rechts', zoneExtra)], ...over,
    }, silent);
    assert.deepStrictEqual(errors, []);
    const core = new NulleinspeisungCore({
        cfg, log, now: () => t.now,
        io: {
            get: (id) => states.get(id),
            setSetpoint: (id, v) => { writes.push([id, v]); return Promise.resolve(); },
            publish: (id, v) => { pub[id] = v; return Promise.resolve(); },
        },
    });
    put(BMS.soc, 50); put(BMS.online, true); put(BMS.limit, 20); put(BMS.prot, false);
    for (const z of ['links', 'rechts']) {
        put(METER(z), 0);
        for (const w of ['WR1', 'WR2']) { put(SET(z, w), 100); put(ACT(z, w), 100); }
    }
    const list = (z, over2 = {}) => ['WR1', 'WR2'].map((w) => ({ name: w, setId: SET(z, w), actualId: ACT(z, w), maxW: 1000, enabled: true, ...over2 }));
    if (init) {
        for (const z of ['links', 'rechts']) core.applyInverters(z, list(z), true);
        core.start();
    }
    return { t, core, writes, pub, put, list, states };
}
const sets = (writes) => writes.map((w) => `${w[0].split('.').slice(1, 3).join('.')}=${w[1]}`);

(async () => {
    await test('Konfiguration: Standardwerte sind gültig', () => {
        const r = normalizeConfig({}, silent);
        assert.deepStrictEqual(r.errors, []);
        assert.strictEqual(r.cfg.socCutoffPercent, 20);
        assert.strictEqual(r.cfg.zones.length, 0);
        assert.strictEqual(r.cfg.dryRun, false);
    });
    await test('Konfiguration: Fehler in globalen Werten', () => {
        const r = normalizeConfig({ socId: 'a b', regulatorIntervalMs: 10, regulationLogLevel: 'trace', peakDetectionThresholdW: 3000, peakMaxW: 2500, wrActualScale: 0, maxMeterAgeS: 'x' }, silent);
        assert.strictEqual(r.errors.length, 6);
    });
    await test('Konfiguration: BMS-Datenpunkt darf leer sein, wenn die Prüfung aus ist', () => {
        assert.deepStrictEqual(normalizeConfig({ bmsOnlineId: '', checkBmsOnline: false }, silent).errors, []);
        assert.strictEqual(normalizeConfig({ bmsOnlineId: '', checkBmsOnline: true }, silent).errors.length, 1);
        assert.strictEqual(normalizeConfig({ socId: '' }, silent).errors.length, 1);
    });
    await test('Konfiguration: Zonenzeilen prüfen', () => {
        reset();
        const r = normalizeConfig({ zones: [
            zoneRow('a'),
            zoneRow('a', { meterId: 'x.y', groupPath: 'g.other' }), // Name doppelt
            zoneRow('b c'),                                        // Leerzeichen
            zoneRow('info', { meterId: 'm.i', groupPath: 'g.i' }), // reserviert
            zoneRow('d', { meterId: 'm d', groupPath: 'g.d' }),    // Zähler ungültig
            zoneRow('e', { groupPath: 'g.a', meterId: 'm.e' }),    // Gruppe doppelt
            zoneRow('f', { meterId: 'm.a', groupPath: 'g.f' }),    // Zähler doppelt
            zoneRow('g', { maxW: 0, meterId: 'm.g', groupPath: 'g.g' }),
            { name: '', meterId: '', groupPath: '' },              // leer, still ignoriert
            { name: 'h', meterId: 'm.h', groupPath: 'g.h', maxW: '' }, // Standard-Maximalleistung
        ] }, log);
        assert.deepStrictEqual(r.cfg.zones.map((z) => z.name), ['a', 'h']);
        assert.strictEqual(r.cfg.zones[1].maxW, 2000);
        assert.strictEqual(r.cfg.zones[1].active, false);
        assert.strictEqual(logs.warn.length, 7);
    });
    await test('Verteilung: gleichmäßig, begrenzt je Wechselrichter', () => {
        const { core } = mk();
        const z = core.zone('links');
        assert.deepStrictEqual(core.distribute(z, 500), [250, 250]);
        assert.deepStrictEqual(core.distribute(z, 99999), [1000, 1000]);
        z.inverters[0].maxW = 300;
        assert.deepStrictEqual(core.distribute(z, 1000), [300, 700]);
        assert.deepStrictEqual(core.distribute(z, 0), [0, 0]);
    });
    await test('Regelung: Sollwert = Istwert + Zählerwert, Verteilung auf die Wechselrichter', () => {
        const { core, writes, put, pub } = mk();
        put(METER('links'), 300);
        core.runControlLoop();
        assert.deepStrictEqual(sets(writes), ['links.WR1=250', 'links.WR2=250']);
        assert.strictEqual(core.zone('links').lastTarget, 500);
        assert.strictEqual(pub['links.Soll_W'], 500);
        assert.strictEqual(pub['links.Zaehler_W'], 300);
        assert.strictEqual(pub.Gesperrt, '');
        assert.strictEqual(pub['info.connection'], true);
    });
    await test('Regelung: Totband hält den Sollwert, Maximalleistung begrenzt', () => {
        const a = mk(); a.put(METER('links'), 10); a.core.runControlLoop();
        assert.strictEqual(a.writes.length, 0);
        const b = mk(); b.put(METER('links'), 9000); b.core.runControlLoop();
        assert.strictEqual(b.core.zone('links').lastTarget, 2000);
        const c = mk(); c.put(METER('links'), -5000); c.core.runControlLoop();
        assert.strictEqual(c.core.zone('links').lastTarget, 0); // Einspeisung -> nicht unter 0 W
    });
    await test('Latenzsperre: wartet auf die Rückmeldung, Freigabe bei Erreichen oder Timeout', () => {
        const { core, writes, put, t } = mk();
        put(METER('links'), 300); core.runControlLoop(); writes.length = 0;
        put(METER('links'), 400); core.runControlLoop();           // Ist 200 W, Ziel 500 W -> gesperrt
        assert.strictEqual(writes.length, 0);
        put(ACT('links', 'WR1'), 250); put(ACT('links', 'WR2'), 250);
        core.runControlLoop();                                      // erreicht -> Freigabe, Zähler +400 -> neuer Sollwert 900
        assert.strictEqual(core.zone('links').lastTarget, 900);
        reset(); writes.length = 0;
        put(METER('links'), 400); core.runControlLoop();
        t.now += 10_001; core.housekeeping();
        assert.strictEqual(core.zone('links').waiting, false);
        assert.strictEqual(logs.warn.some((m) => m.includes('Timeout')), true);
    });
    await test('Budget: kleiner Bedarf wird voll bedient, Rest geht an die andere Zone', () => {
        const { core, put } = mk({ totalBmsLimitW: 1500 });
        put(METER('links'), 400); put(METER('rechts'), 2500); // Wünsche 600 W und 2000 W (Max)
        core.runControlLoop();
        assert.strictEqual(core.zone('links').lastTarget, 600);
        assert.strictEqual(core.zone('rechts').lastTarget, 900);
    });
    await test('Budget: gleiche Wünsche teilen sich das Limit', () => {
        const { core, put } = mk({ totalBmsLimitW: 3000 });
        put(METER('links'), 2000); put(METER('rechts'), 2000);
        core.runControlLoop();
        assert.strictEqual(core.zone('links').lastTarget, 1500);
        assert.strictEqual(core.zone('rechts').lastTarget, 1500);
    });
    await test('Budget: Gesamtlimit gilt auch innerhalb des Totbands strikt', () => {
        const { core, put, list } = mk({ totalBmsLimitW: 3000 }, {}, { init: false });
        put(SET('links', 'WR1'), 755); put(SET('links', 'WR2'), 755); put(ACT('links', 'WR1'), 755); put(ACT('links', 'WR2'), 755);
        put(SET('rechts', 'WR1'), 0); put(SET('rechts', 'WR2'), 0); put(ACT('rechts', 'WR1'), 0); put(ACT('rechts', 'WR2'), 0);
        for (const z of ['links', 'rechts']) core.applyInverters(z, list(z), true);
        core.start();
        put(METER('links'), 0); put(METER('rechts'), 1500);
        core.runControlLoop();
        assert.strictEqual(core.zone('rechts').lastTarget, 1500);
        assert.strictEqual(core.zone('links').lastTarget, 1500); // von 1510 auf 1500 reduziert
        assert.ok(core.zone('links').lastTarget + core.zone('rechts').lastTarget <= 3000);
    });
    await test('Sperren: BMS offline, Schutz, Entladelimit, Hauptschalter -> alle auf 0 W', () => {
        for (const [mutate, reason] of [
            [(m) => m.put(BMS.online, false), 'BMS offline'],
            [(m) => m.put(BMS.prot, true), 'BMS-Schutz aktiv'],
            [(m) => m.put(BMS.limit, 0.5), 'BMS-Entladelimit'],
            [(m) => { m.core.enabled = false; }, 'Hauptschalter aus'],
            [(m) => m.states.delete(BMS.soc), 'SoC ungültig'],
        ]) {
            const m = mk(); mutate(m); m.core.runControlLoop();
            assert.deepStrictEqual(sets(m.writes), ['links.WR1=0', 'links.WR2=0', 'rechts.WR1=0', 'rechts.WR2=0'], reason);
            assert.ok(m.pub.Gesperrt.includes(reason), reason);
            assert.strictEqual(m.pub['info.connection'], false);
        }
    });
    await test('Sperren: Prüfungen lassen sich abschalten', () => {
        const m = mk({ checkBmsOnline: false, checkBmsProtection: false, checkBmsDischargeLimit: false });
        m.put(BMS.online, false); m.put(BMS.prot, true); m.put(BMS.limit, 0);
        m.put(METER('links'), 300); m.core.runControlLoop();
        assert.strictEqual(m.pub.Gesperrt, '');
        assert.strictEqual(m.core.zone('links').lastTarget, 500);
    });
    await test('Akkuschutz: Abschaltung ab Grenze, Wiederfreigabe mit Hysterese', () => {
        const m = mk();
        m.put(BMS.soc, 20); m.core.runControlLoop();
        assert.ok(m.pub.Gesperrt.startsWith('SoC 20'));
        assert.strictEqual(m.pub.Akku_Gesperrt, true);
        m.put(BMS.soc, 22); m.core.runControlLoop();
        assert.strictEqual(m.pub.Akku_Gesperrt, true);
        m.put(BMS.soc, 23); m.put(METER('links'), 300); m.core.runControlLoop();
        assert.strictEqual(m.pub.Akku_Gesperrt, false);
        assert.strictEqual(m.pub.Gesperrt, '');
    });
    await test('Akkuschutz: Start unterhalb der Wiederfreigabe bleibt gesperrt', () => {
        const m = mk({}, {}, { init: false });
        m.put(BMS.soc, 21);
        for (const z of ['links', 'rechts']) m.core.applyInverters(z, m.list(z), true);
        m.core.start();
        assert.strictEqual(m.core.isBatteryDisabled, true);
    });
    await test('Zonen-Sperre: Zähler veraltet, ungültig, Rückmeldung fehlt, keine Wechselrichter', () => {
        const a = mk(); a.put(METER('links'), 300, a.t.now - 16_000); a.core.runControlLoop();
        assert.ok(a.pub['links.Gesperrt'].includes('älter als 15 s'));
        assert.strictEqual(a.pub['rechts.Gesperrt'], '');
        assert.strictEqual(a.pub['info.connection'], true);
        const b = mk(); b.put(METER('links'), 'abc'); b.core.runControlLoop();
        assert.strictEqual(b.pub['links.Gesperrt'], 'Zählerwert ungültig');
        const c = mk(); c.states.delete(ACT('links', 'WR2')); c.core.runControlLoop();
        assert.strictEqual(c.pub['links.Gesperrt'], 'Wechselrichter-Rückmeldung ungültig');
        const d = mk({}, {}, { init: false }); d.core.start(); d.core.runControlLoop();
        assert.strictEqual(d.pub['links.Gesperrt'], 'keine aktiven Wechselrichter');
        assert.strictEqual(d.pub['info.connection'], false);
    });
    await test('Zonen-Sperre: gesperrte Zone wird auf 0 W gesetzt und zählt als festes Budget', () => {
        const { core, writes, put, t } = mk({ totalBmsLimitW: 1000 });
        put(METER('links'), 900, t.now - 16_000); put(METER('rechts'), 2000);
        core.runControlLoop();
        assert.deepStrictEqual(sets(writes).slice(0, 2), ['links.WR1=0', 'links.WR2=0']);
        assert.strictEqual(core.zone('rechts').lastTarget, 1000);
    });
    await test('Vorsteuerung: Erkennung, Halten und Ende nach der Taktpause', () => {
        const { core, put, t, writes } = mk();
        const z = core.zone('links');
        put(METER('links'), 100); core.handleMeterUpdate(z, { val: 100 });
        t.now += 500; put(METER('links'), 1500); core.handleMeterUpdate(z, { val: 1500 });
        assert.strictEqual(z.ff.active, true);
        assert.strictEqual(z.ff.base, 200);
        assert.strictEqual(z.ff.predicted, 700);
        assert.strictEqual(z.lastTarget, 900);                      // Basis 200 + 700 W, trotz hohen Zählerwerts
        assert.strictEqual(writes.length, 2);
        t.now += 3_400; core.housekeeping();
        assert.strictEqual(z.ff.active, true);
        t.now += 200; core.housekeeping();
        assert.strictEqual(z.ff.active, false);
    });
    await test('Vorsteuerung: zu große Sprünge, deaktiviert und inaktive Zone lösen nichts aus', () => {
        const a = mk(); const z = a.core.zone('links');
        a.core.handleMeterUpdate(z, { val: 0 }); a.t.now += 500; a.core.handleMeterUpdate(z, { val: 3000 });
        assert.strictEqual(z.ff.active, false);
        const b = mk({ feedForwardEnabled: false }); const zb = b.core.zone('links');
        b.core.handleMeterUpdate(zb, { val: 0 }); b.t.now += 500; b.core.handleMeterUpdate(zb, { val: 1500 });
        assert.strictEqual(zb.ff.active, false);
        const c = mk({}, { active: false }); const zc = c.core.zone('links');
        c.core.handleMeterUpdate(zc, { val: 0 }); c.t.now += 500; c.core.handleMeterUpdate(zc, { val: 1500 });
        assert.strictEqual(zc.ff.active, false);
    });
    await test('Vorsteuerung: Abbruch bei hoher mittlerer Einspeisung und nach Maximaldauer', () => {
        const a = mk(); const z = a.core.zone('links');
        a.core.handleMeterUpdate(z, { val: 100 }); a.t.now += 500; a.core.handleMeterUpdate(z, { val: 1500 });
        assert.strictEqual(z.ff.active, true);
        for (let i = 0; i < 8; i++) { a.t.now += 1_500; a.put(METER('links'), -600); a.core.handleMeterUpdate(z, { val: -600 }); }
        z.waiting = false; a.core.runControlLoop();
        assert.strictEqual(z.ff.active, false);
        const b = mk({ feedForwardMaxDurationS: 1 }); const zb = b.core.zone('links');
        b.core.handleMeterUpdate(zb, { val: 100 }); b.t.now += 500; b.core.handleMeterUpdate(zb, { val: 1500 });
        b.t.now += 1_100; zb.ff.lastPeakTs = b.t.now; zb.waiting = false; b.core.runControlLoop();
        assert.strictEqual(zb.ff.active, false);
    });
    await test('Wechselrichter-Liste: Start übernimmt Sollwerte, abgeschaltete gehen auf 0 W', () => {
        const m = mk({}, {}, { init: false });
        m.core.applyInverters('links', [...m.list('links').slice(0, 1), { ...m.list('links')[1], enabled: false }], true);
        assert.deepStrictEqual(sets(m.writes), ['links.WR2=0']);
        assert.strictEqual(m.core.zone('links').lastTarget, 100);
        assert.strictEqual(m.core.zone('links').inverters.length, 1);
    });
    await test('Wechselrichter-Liste: geänderte Liste -> alles 0 W, geänderte Auswahl -> andere laufen weiter', () => {
        const m = mk();
        const z = m.core.zone('links');
        z.lastTarget = 200; m.writes.length = 0;
        m.core.applyInverters('links', m.list('links', { maxW: 500 }));          // MaxW geändert
        assert.deepStrictEqual(sets(m.writes), ['links.WR1=0', 'links.WR2=0']);
        assert.strictEqual(z.lastTarget, 0);
        m.writes.length = 0;
        const l = m.list('links', { maxW: 500 }); l[1].enabled = false;           // nur Auswahl
        z.lastTarget = 200;
        m.core.applyInverters('links', l);
        assert.deepStrictEqual(sets(m.writes), ['links.WR2=0']);
        assert.strictEqual(z.lastTarget, 100);                                    // WR1 läuft mit 100 W weiter
        m.writes.length = 0;
        m.core.applyInverters('links', l);                                       // unverändert: nichts
        assert.strictEqual(m.writes.length, 0);
    });
    await test('Inaktive Zone: es wird nichts geschrieben', () => {
        const m = mk({}, {}, { init: false });
        m.core.zone('links').active = false;
        m.core.applyInverters('links', m.list('links', { enabled: false }), true);
        assert.strictEqual(m.writes.length, 0);
        m.core.applyInverters('rechts', m.list('rechts'), true); m.core.start(); m.writes.length = 0;
        m.put(BMS.online, false); m.core.runControlLoop();
        assert.deepStrictEqual(sets(m.writes), ['rechts.WR1=0', 'rechts.WR2=0']);
    });
    await test('Testlauf: keine Sollwerte, nur Protokoll', async () => {
        reset();
        const m = mk({ dryRun: true }); m.put(METER('links'), 300);
        m.core.runControlLoop();
        assert.strictEqual(m.writes.length, 0);
        assert.strictEqual(m.core.zone('links').lastTarget, 500);
        assert.ok(logs.info.some((x) => x.includes('[Testlauf]')));
        await m.core.shutdown();
        assert.strictEqual(m.writes.length, 0);
    });
    await test('Beim Stoppen: alle aktiven Wechselrichter auf 0 W (abschaltbar)', async () => {
        const a = mk(); await a.core.shutdown();
        assert.deepStrictEqual(sets(a.writes), ['links.WR1=0', 'links.WR2=0', 'rechts.WR1=0', 'rechts.WR2=0']);
        const b = mk({ zeroOnStop: false }); await b.core.shutdown();
        assert.strictEqual(b.writes.length, 0);
    });
    await test('Log-Level der Regelzeile', () => {
        reset();
        const a = mk(); a.put(METER('links'), 300); a.core.runControlLoop();
        assert.strictEqual(logs.info.some((x) => x.includes('Soll 500 W')), false);
        assert.strictEqual(logs.debug.some((x) => x.includes('Soll 500 W')), true);
        reset();
        const b = mk({ regulationLogLevel: 'info' }); b.put(METER('links'), 300); b.core.runControlLoop();
        assert.strictEqual(logs.info.some((x) => x.includes('Soll 500 W')), true);
    });
    await test('Beobachtete Datenpunkte und Pflicht-Datenpunkte', () => {
        const { core } = mk();
        const ids = core.watchedIds();
        assert.ok(ids.has(BMS.soc) && ids.has(METER('rechts')) && ids.has(ACT('links', 'WR2')) && ids.has(SET('rechts', 'WR1')));
        assert.strictEqual(core.requiredIds().length, 4 + 2);
        const m2 = mk({ checkBmsOnline: false, checkBmsProtection: false, checkBmsDischargeLimit: false });
        assert.strictEqual(m2.core.requiredIds().length, 1 + 2);
        assert.strictEqual(m2.core.zoneByMeter(METER('links')).name, 'links');
    });

    await test('Export/Import: Rundlauf', () => {
        const native = { ...DEFAULTS, socId: 'x.0.SoC', totalBmsLimitW: 2500, dryRun: true, regulationLogLevel: 'info', zones: [zoneRow('links'), zoneRow('rechts', { active: false, maxW: 1500 })], configJson: 'alt' };
        const ex = exportConfig(native);
        const parsed = JSON.parse(ex.native.configJson);
        assert.strictEqual(parsed.adapter, 'nulleinspeisung');
        assert.strictEqual(JSON.stringify(parsed).includes('alt'), false);
        const im = importConfig(ex.native.configJson);
        assert.strictEqual(im.error, undefined);
        assert.strictEqual(im.native.socId, 'x.0.SoC');
        assert.strictEqual(im.native.totalBmsLimitW, 2500);
        assert.strictEqual(im.native.dryRun, true);
        assert.strictEqual(im.native.regulationLogLevel, 'info');
        assert.deepStrictEqual(im.native.zones, parsed.config.zones);
        assert.strictEqual(im.native.zones[1].maxW, 1500);
        assert.strictEqual(im.native.configJson, '');
    });
    await test('Import: reines config-Objekt, ungültige Zeilen werden gemeldet', () => {
        const im = importConfig(JSON.stringify({ totalBmsLimitW: 2000, zones: [zoneRow('a'), zoneRow('b c')] }));
        assert.strictEqual(im.native.totalBmsLimitW, 2000);
        assert.strictEqual(im.native.zones.length, 1);
        assert.ok(im.result.includes('Übersprungen'));
    });
    await test('Import: Fehlerfälle', () => {
        assert.ok(importConfig('').error);
        assert.ok(importConfig('{kaputt').error);
        assert.ok(importConfig('[1]').error);
        assert.ok(importConfig('{"adapter":"netzlimit","config":{}}').error);
        assert.ok(importConfig('{"version":2,"config":{}}').error);
        assert.ok(importConfig('{"config":{"zones":"x"}}').error);
        assert.ok(importConfig('{"config":{"socCutoffPercent":150}}').error);
        assert.ok(importConfig('{"config":{"regulationLogLevel":"trace"}}').error);
        assert.ok(importConfig('x'.repeat(200001)).error);
    });
    await test('Export: leere Konfiguration liefert Standardwerte', () => {
        const c = JSON.parse(exportConfig(undefined).native.configJson).config;
        assert.strictEqual(c.deadBandWatts, 15);
        assert.deepStrictEqual(c.zones, []);
    });
    await test('io-package.json und Admin-Maske passen zum Modell', () => {
        const io = require('../io-package.json');
        const { KEYS } = require('../lib/model');
        assert.deepStrictEqual({ ...io.native, configJson: undefined }, { ...DEFAULTS, configJson: undefined });
        assert.strictEqual(io.native.configJson, '');
        assert.strictEqual(require('../package.json').version, io.common.version);
        assert.deepStrictEqual(normalizeConfig(io.native, silent).errors, []);
        const ui = require('../admin/jsonConfig.json');
        const shown = new Set(Object.values(ui.items).flatMap((p) => Object.keys(p.items)).filter((k) => !k.startsWith('_') && k !== 'zones' && k !== 'configJson'));
        assert.deepStrictEqual([...shown].sort(), [...KEYS].sort());
    });
    console.log(`\n${passed} Tests bestanden`);
})().catch((e) => { console.error(e); process.exit(1); });
