# ioBroker.nulleinspeisung

Regelt die **Sollwerte der Wechselrichter** so, dass der Zähler jeder **Zone** (z. B. einer Wohnung) möglichst null anzeigt. Mehrere Zonen teilen sich einen Akku: Der Adapter hält ein gemeinsames Entladelimit des BMS ein, schützt den Akku über den SoC und erkennt getaktete Großlasten.
Er ersetzt das Skript „Nulleinspeisung 2 Wohnungen“ (Version 7, `0_userdata.0.Nulleinspeisung`).

## Funktionsweise
- **Regelung je Zone:** Sollwert = aktuelle Wechselrichter-Leistung + Zählerwert (Bezug +, Einspeisung −), begrenzt auf 0 … Zonenmaximum. Die Leistung wird gleichmäßig auf die Wechselrichter verteilt, begrenzt durch deren `MaxW`.
- **Totband und Latenzsperre:** Kleine Abweichungen (Standard 15 W) lösen nichts aus. Nach einem Sollwert wartet die Zone, bis der Istwert das Ziel erreicht hat (Toleranz 40 W, höchstens 10 s).
- **Gemeinsames BMS-Budget:** Das Gesamtlimit (Standard 3000 W) wird fair verteilt: Kleine Wünsche werden voll bedient, der Rest wird geteilt. Auch innerhalb des Totbands wird das Gesamtlimit strikt eingehalten.
- **Akkuschutz:** Abschaltung bei SoC ≤ 20 %, Wiederfreigabe erst ab 23 % (Hysterese). Zusätzlich werden BMS online, Entladestrom-Limit (mindestens 1 A) und die Schutzmeldung geprüft. Jede dieser BMS-Prüfungen lässt sich abschalten.
- **Vorsteuerung für getaktete Lasten:** Springt der Zähler schnell um 1200 bis 2500 W (z. B. Herdplatte oder Heizstab), hält die Zone die Leistung bei „Basis + geschätzter Anteil“ konstant, statt der Taktung hinterherzuregeln. Sie endet nach einer Pause, nach der Maximaldauer oder bei hoher mittlerer Einspeisung.
- **Wechselrichter automatisch erkannt:** Unter der Gruppe einer Zone werden `<Gruppe>.WR<x>.Power` mit zugehörigem `InvOutputWatts` gefunden (jede Minute geprüft). Je Wechselrichter gibt es die Datenpunkte `Aktiv` und `MaxW`.

## Sicherheitsverhalten
- **Fehlt eine Voraussetzung, gehen die betroffenen Wechselrichter auf 0 W:** BMS offline, Schutz aktiv, Entladelimit zu niedrig, SoC ungültig oder zu niedrig (alle Zonen) sowie Zähler ungültig oder älter als 15 s, Rückmeldung der Wechselrichter ungültig oder keine aktiven Wechselrichter (nur diese Zone).
- **Hauptschalter** `nulleinspeisung.0.Aktiv`: aus = alle Wechselrichter auf 0 W.
- **Beim Stoppen des Adapters** gehen alle aktiven Wechselrichter auf 0 W (abschaltbar), damit keine ungeregelte Leistung zurückbleibt.
- **Ändert sich die Wechselrichter-Liste oder ein `MaxW`,** werden die Wechselrichter der Zone sicherheitshalber auf 0 W gesetzt und die Regelung beginnt neu. Eine geänderte Auswahl (`Aktiv`) lässt die anderen Wechselrichter unberührt weiterlaufen.
- **Neue Zonen sind inaktiv.** Ein **Testlauf** protokolliert nur, was geschrieben würde, und schreibt nichts.
- Fehlerhafte Konfiguration oder fehlende Pflicht-Datenpunkte: Der Adapter regelt nicht und meldet es im Log. Fehlende Datenpunkte (z. B. weil das BMS später startet) werden regelmäßig neu geprüft.

## Installation über GitHub
1. Auf GitHub ein **neues Repository `ioBroker.nulleinspeisung`** anlegen (Benutzer `lars752`).
2. ZIP entpacken und den **Inhalt** des Ordners `ioBroker.nulleinspeisung` (nicht den Ordner selbst) ins Hauptverzeichnis des Repositorys hochladen (Branch `main`). Danach müssen `package.json`, `io-package.json`, `main.js`, `lib/` und `admin/` direkt im Hauptverzeichnis sichtbar sein.
3. ioBroker Admin → Adapter → Experten-Modus → „Adapter aus eigener URL installieren“ → `https://github.com/lars752/ioBroker.nulleinspeisung`
   oder `iobroker url https://github.com/lars752/ioBroker.nulleinspeisung`
4. Instanz `nulleinspeisung.0` anlegen und konfigurieren.

Voraussetzungen: Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.12.2.

## Inbetriebnahme
1. **Altes Skript stoppen.** Skript und Adapter dürfen nicht gleichzeitig laufen, beide würden dieselben Sollwerte schreiben. Den Adapter `netzlimit` weiter laufen lassen: Er greift nur ergänzend ein.
2. Reiter „BMS und Akkuschutz“: Datenpunkte prüfen (Standard `growatt-bms.0.…`).
3. Reiter „Zonen“: je Zone Name, Zähler-Datenpunkt (z. B. `shelly-gruppen.0.wohnung_links.info.Total_Power`) und Wechselrichter-Gruppe (z. B. `ecoflow-gruppen.0.akku_wohnung_links`) eintragen, Maximalleistung setzen.
4. **Testlauf** einschalten, Zone auf „Aktiv“ setzen, speichern und im Log prüfen, was der Adapter täte (Log-Stufe der Regelzeilen vorübergehend auf `info`).
5. Testlauf ausschalten.

## Konfiguration
Alle Parameter stehen in der Instanz in den Reitern „Zonen“, „BMS und Akkuschutz“, „Wechselrichter“, „Regelung“ und „Vorsteuerung“; die Standardwerte entsprechen dem Skript. Änderungen starten die Instanz neu.

Zonentabelle: **Name** (Ordner unter `nulleinspeisung.0`), **Aktiv**, **Zähler-Datenpunkt** (Bezug +, Einspeisung −), **Wechselrichter-Gruppe** (Pfad), **Max. Leistung** der Zone.

## Datenpunkte (`nulleinspeisung.0.*`)
| Datenpunkt | Inhalt |
|---|---|
| `Aktiv` | Hauptschalter (schreibbar) |
| `Gesperrt` | Grund einer globalen Sperre, leer = keine |
| `Akku_Gesperrt` | Akkuschutz aktiv |
| `<zone>.Zaehler_W` | Zählerwert |
| `<zone>.Ist_W` | Summe der Wechselrichter-Ausgangsleistung |
| `<zone>.Soll_W` | aktuell vorgegebene Gesamt-Sollleistung |
| `<zone>.Gesperrt` | Grund der Sperre, leer = Regelung läuft |
| `<zone>.Vorsteuerung` | Vorsteuerung aktiv |
| `<zone>.<WRx>.Aktiv` | Wechselrichter beteiligt (schreibbar) |
| `<zone>.<WRx>.MaxW` | Maximalleistung, 0 = Standard (schreibbar) |
| `info.connection` | mindestens eine Zone aktiv und nicht gesperrt |

## Umstieg vom Skript
| Skript | Adapter |
|---|---|
| `Aktiv` | `nulleinspeisung.0.Aktiv` |
| `SOC_ID`, `BMS_*_ID`, `CHECK_BMS_*`, `MIN_BMS_DISCHARGE_LIMIT_A`, `SOC_CUTOFF/RESTART_PERCENT`, `TOTAL_BMS_LIMIT_W` | Reiter „BMS und Akkuschutz“ |
| Wechselrichter-Pfade, `MAX_W`, Rescan, Skalierung, Schalter, Latenz | Reiter „Wechselrichter“ und „Regelung“ |
| `PEAK_*`, `ESTIMATED_DUTY_CYCLE`, `TACT_PAUSE_TIMEOUT_MS`, `FEED_FORWARD_*` | Reiter „Vorsteuerung“ |
| `ZONES` (Name, Zähler, Gruppe, Maximalleistung) | Zonentabelle |
| `…Wechselrichter.<WRx>.Aktiv / MaxW` | `nulleinspeisung.0.<zone>.<WRx>.Aktiv / MaxW` |

Danach `0_userdata.0.Nulleinspeisung` löschen. Verbraucher dieser Datenpunkte (z. B. Visualisierungen) auf die neuen Pfade umstellen.

## Import / Export der Konfiguration (JSON)
Im Reiter „Import / Export“ der Instanz:
- **Export:** schreibt die aktuelle Konfiguration (auch ungespeicherte Änderungen) als JSON in das Textfeld; mit dem Kopier-Symbol sichern.
- **Import:** JSON einfügen und „JSON aus dem Textfeld importieren“ drücken. Die Werte erscheinen im Formular, danach „Speichern und schließen“ drücken.
- Ungültige Zonenzeilen werden übersprungen und genannt. Ungültige globale Werte (z. B. SoC-Grenze über 100), defektes JSON oder ein Export einer anderen Adapterart werden abgelehnt.
- Die Instanz muss laufen, weil Export und Import über den Adapter abgewickelt werden.

Format (Auszug; im Export stehen alle Parameter):
```json
{
  "adapter": "nulleinspeisung",
  "version": 1,
  "config": {
    "socId": "growatt-bms.0.SoC",
    "totalBmsLimitW": 3000,
    "dryRun": false,
    "zones": [
      { "name": "links", "active": true, "meterId": "shelly-gruppen.0.wohnung_links.info.Total_Power",
        "groupPath": "ecoflow-gruppen.0.akku_wohnung_links", "maxW": 2000 }
    ]
  }
}
```
Fehlende Felder werden beim Import mit Standardwerten ergänzt.

## Entwicklung
```bash
npm install
npm test     # Regelung, Budget, Sperren, SoC-Hysterese, Vorsteuerung, Wechselrichter-Liste, Import/Export (ohne ioBroker)
```
Struktur: `lib/model.js` (Konfiguration), `lib/core.js` (Regelkern, ohne ioBroker-Abhängigkeit testbar), `lib/configio.js` (JSON-Import/-Export), `main.js` (Adapter: Datenpunkte, Abonnements, Zeitgeber). Der Workflow `.github/workflows/test.yml` führt die Tests bei jedem Push auf Node 18, 20 und 22 aus.

## Lizenz
MIT
