# ioBroker.nulleinspeisung

Regelt die **Sollwerte der Wechselrichter** so, dass der Zähler jeder **Zone** (z. B. einer Wohnung) möglichst null anzeigt. Mehrere Zonen teilen sich einen Akku: Der Adapter hält ein gemeinsames Entladelimit des BMS ein, schützt den Akku über den SoC und erkennt getaktete Großlasten.

## Funktionsweise

- **Regelung je Zone:** Sollwert = aktuelle Wechselrichter-Leistung + Zählerwert (Bezug +, Einspeisung −), begrenzt auf 0 … Zonenmaximum. Die Leistung wird gleichmäßig auf die Wechselrichter verteilt, begrenzt durch deren `MaxW`.
- **Totband und Latenzsperre:** Kleine Abweichungen (Standard 15 W) lösen keine Regelaktion aus. Nach einem Sollwert wartet die Zone, bis der Istwert das Ziel erreicht hat (Toleranz 40 W, höchstens 10 s).
- **Gemeinsames BMS-Budget:** Das Gesamtlimit (Standard 3000 W) wird fair verteilt: Kleine Wünsche werden voll bedient, der Rest wird geteilt. Auch innerhalb des Totbands wird das Gesamtlimit strikt eingehalten.
- **Akkuschutz:** Abschaltung bei SoC ≤ 20 %, Wiederfreigabe erst ab 23 % (Hysterese). Zusätzlich werden BMS-Online-Status, Entladestrom-Limit (mindestens 1 A) und die Schutzmeldung geprüft – jede dieser Prüfungen lässt sich abschalten.
- **Vorsteuerung für getaktete Lasten:** Springt der Zähler schnell um 1200 bis 2500 W (z. B. Herdplatte oder Heizstab), hält die Zone die Leistung bei „Basis + geschätzter Anteil" konstant, statt der Taktung hinterherzuregeln. Sie endet nach einer Pause, nach der Maximaldauer oder bei hoher mittlerer Einspeisung.
- **Wechselrichter automatisch erkannt:** Unter der Gruppe einer Zone werden `WR<x>.Power` mit zugehörigem `InvOutputWatts` gefunden (jede Minute geprüft). Je Wechselrichter gibt es die Datenpunkte `Aktiv` und `MaxW`.

## Sicherheitsverhalten

- **Fehlt eine Voraussetzung, gehen die betroffenen Wechselrichter auf 0 W:** BMS offline, Schutz aktiv, Entladelimit zu niedrig, SoC ungültig oder zu niedrig (alle Zonen) sowie Zähler ungültig oder veraltet, Rückmeldung der Wechselrichter ungültig oder keine aktiven Wechselrichter (nur diese Zone).
- **Hauptschalter** `nulleinspeisung.0.Aktiv`: aus = alle Wechselrichter auf 0 W.
- **Beim Stoppen** gehen alle aktiven Wechselrichter auf 0 W (abschaltbar).
- **Ändert sich die Wechselrichter-Liste oder ein `MaxW`,** werden die Wechselrichter der Zone auf 0 W gesetzt und die Regelung beginnt neu.
- **Neue Zonen sind inaktiv.** Ein **Testlauf** protokolliert nur, was geschrieben würde.
- Fehlerhafte Konfiguration oder fehlende Pflicht-Datenpunkte: Der Adapter regelt nicht und meldet es im Log.

## Installation

1. ioBroker Admin → Adapter → Experten-Modus → „Adapter aus eigener URL installieren":  
   `https://github.com/lars752/ioBroker.nulleinspeisung`  
   Alternativ: `iobroker url https://github.com/lars752/ioBroker.nulleinspeisung`
2. Instanz anlegen und konfigurieren.

**Voraussetzungen:** Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.12.2.

## Inbetriebnahme

1. Im Reiter **„BMS und Akkuschutz"** die Datenpunkte des BMS eintragen.
2. Im Reiter **„Zonen"** je Zone Name, Zähler-Datenpunkt und Wechselrichter-Gruppe eintragen, Maximalleistung setzen.
3. **Testlauf** einschalten, Zone auf **Aktiv** setzen, speichern und im Log prüfen, was der Adapter täte.
4. Testlauf ausschalten.

## Konfiguration

Alle Parameter stehen in der Instanz in den Reitern **„Zonen"**, **„BMS und Akkuschutz"**, **„Wechselrichter"**, **„Regelung"** und **„Vorsteuerung"**. Änderungen starten die Instanz neu.

**Zonentabelle:** Name (Ordner unter `nulleinspeisung.0`), Aktiv, Zähler-Datenpunkt (Bezug +, Einspeisung −), Wechselrichter-Gruppe (Pfad zur Gruppe), Max. Leistung der Zone.

| Einstellung | Standard | Bedeutung |
|---|---|---|
| SoC-Abschalten | 20 % | Alle Wechselrichter auf 0 W |
| SoC-Wiederfreigabe | 23 % | Regelung läuft wieder |
| BMS-Gesamtlimit | 3000 W | Summe aller Zonen |
| Totband | 15 W | Mindestabweichung für Regelaktion |
| Regeltakt | 3000 ms | Mindestabstand zwischen Regelaktionen |
| Max. Alter Zählerwert | 15 s | Ältere Werte sperren die Zone |
| Auf 0 W beim Stoppen | an | Wechselrichter beim Adapter-Stopp nullen |
| Testlauf | aus | Nur protokollieren, nichts schreiben |

## Datenpunkte (`nulleinspeisung.0.*`)

| Datenpunkt | Inhalt |
|---|---|
| `Aktiv` | Hauptschalter (schreibbar) |
| `Gesperrt` | Grund einer globalen Sperre, leer = keine |
| `Akku_Gesperrt` | Akkuschutz aktiv |
| `<zone>.Zaehler_W` | Zählerwert der Zone |
| `<zone>.Ist_W` | Summe der Wechselrichter-Ausgangsleistung |
| `<zone>.Soll_W` | aktuell vorgegebene Gesamt-Sollleistung |
| `<zone>.Gesperrt` | Grund der Sperre, leer = Regelung läuft |
| `<zone>.Vorsteuerung` | Vorsteuerung aktiv |
| `<zone>.<WRx>.Aktiv` | Wechselrichter beteiligt (schreibbar) |
| `<zone>.<WRx>.MaxW` | Maximalleistung, 0 = Standard (schreibbar) |
| `info.connection` | mindestens eine Zone aktiv und nicht gesperrt |

## Import / Export der Konfiguration

Im Reiter **„Import / Export"** der Instanz:

- **Export:** schreibt die aktuelle Konfiguration als JSON in das Textfeld.
- **Import:** JSON einfügen und „JSON aus dem Textfeld importieren" drücken. Die Werte erscheinen im Formular, danach „Speichern und schließen".

Ungültige Zonenzeilen, fehlerhaftes JSON oder der Export einer anderen Adapterart werden abgelehnt. Fehlende Felder werden mit Standardwerten ergänzt.

```json
{
  "adapter": "nulleinspeisung",
  "version": 1,
  "config": {
    "socId": "<SoC-Datenpunkt>",
    "totalBmsLimitW": 3000,
    "dryRun": false,
    "zones": [
      { "name": "<zone>", "active": true,
        "meterId": "<Zähler-Datenpunkt>",
        "groupPath": "<Wechselrichter-Gruppe>",
        "maxW": 2000 }
    ]
  }
}
```

## Laufzeit-API für den Agenten

Der Adapter [nulleinspeisung-agent](https://github.com/lars752/ioBroker.nulleinspeisung-agent) kann Parameter per `sendTo` ohne Neustart ändern:

- `getConfig` liefert die aktuell wirksamen Werte.
- `setConfig` übernimmt geprüfte Werte und antwortet mit `{ applied, rejected }`.

Änderbar sind `deadBandWatts`, `regulatorIntervalMs`, `maxLatencyTimeoutS`, `latencyToleranceW`, `feedForwardEnabled`, `peakDetectionThresholdW`, `estimatedDutyCycle`, `tactPauseTimeoutMs`, `socCutoffPercent` und `socRestartPercent`. Werte außerhalb der Grenzen der Konfiguration werden abgelehnt. Wird nur `socCutoffPercent` gesetzt, bleibt die Wiederfreigabe im bisherigen Abstand darüber (Standard +3 %). Die Änderungen gelten bis zum nächsten Adapter-Neustart; danach gilt wieder die Instanzkonfiguration.

## Entwicklung

```bash
npm install
npm test     # läuft ohne ioBroker-Instanz
```

Struktur: `lib/model.js` (Konfiguration), `lib/core.js` (Regelkern), `lib/configio.js` (JSON-Import/-Export), `main.js` (Adapter).  
Der Workflow `.github/workflows/test.yml` führt die Tests bei jedem Push auf Node 18, 20 und 22 aus.

## Lizenz

MIT
