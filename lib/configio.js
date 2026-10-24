'use strict';
/**
 * JSON-Import/-Export der Instanz-Konfiguration für die Admin-Oberfläche.
 * Rückgabeformat passt zu jsonConfig-sendTo mit useNative.
 */
const { KEYS, normalizeConfig, rowsOf } = require('./model');

const ADAPTER = 'nulleinspeisung';
const FORMAT = 1;
const MAX_CHARS = 200000;

const collector = () => {
    const msgs = [];
    return { msgs, log: { debug() {}, info() {}, warn: (m) => msgs.push(m), error: (m) => msgs.push(m) } };
};
const flat = (cfg) => ({ ...Object.fromEntries(KEYS.map((k) => [k, cfg[k]])), zones: rowsOf(cfg.zones) });

/** Erzeugt den Exporttext aus den (auch ungespeicherten) Formulardaten. */
function exportConfig(native) {
    const c = collector();
    const { cfg, errors } = normalizeConfig(native, c.log);
    const text = JSON.stringify({ adapter: ADAPTER, version: FORMAT, config: flat(cfg) }, null, 2);
    const notes = [];
    if (errors.length) notes.push(`${errors.length} ungültige Einstellung(en) wurden durch Standardwerte ersetzt`);
    if (c.msgs.length) notes.push(`${c.msgs.length} ungültige Zonenzeile(n) nicht exportiert`);
    return {
        native: { configJson: text },
        result: `Konfiguration mit ${cfg.zones.length} Zone(n) exportiert. Text aus dem Feld kopieren und sichern.${notes.length ? ` Hinweis: ${notes.join('; ')}.` : ''}`,
    };
}

/** Prüft einen Importtext; liefert { native, result } oder { error }. */
function importConfig(text) {
    const raw = String(text || '').trim();
    if (!raw) return { error: 'Das Feld „Konfiguration (JSON)“ ist leer.' };
    if (raw.length > MAX_CHARS) return { error: 'Der Text ist zu groß (max. 200 000 Zeichen).' };
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        return { error: `Kein gültiges JSON: ${e.message}` };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'Erwartet wird ein JSON-Objekt.' };
    if (data.adapter !== undefined && data.adapter !== ADAPTER) return { error: `Export gehört zu „${data.adapter}“, erwartet „${ADAPTER}“.` };
    if (data.version !== undefined && data.version !== FORMAT) return { error: `Nicht unterstützte Formatversion ${data.version}.` };
    const src = data.config && typeof data.config === 'object' ? data.config : data;
    if (src.zones !== undefined && !Array.isArray(src.zones)) return { error: '„zones“ muss eine Liste sein.' };
    const c = collector();
    const { cfg, errors } = normalizeConfig(src, c.log);
    if (errors.length) return { error: `Ungültige Werte: ${errors.join('; ')}` };
    let result = `${cfg.zones.length} Zone(n) übernommen. Bitte „Speichern und schließen“ drücken, um die Konfiguration zu aktivieren.`;
    if (c.msgs.length) result += ` Übersprungen: ${c.msgs.slice(0, 5).join('; ')}${c.msgs.length > 5 ? ` … (+${c.msgs.length - 5})` : ''}`;
    return { native: { ...flat(cfg), configJson: '' }, result };
}

module.exports = { exportConfig, importConfig };
