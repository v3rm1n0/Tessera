# Voreinlass

Einlass-Monitoring mit Rollen, QR-Code-Generierung und mobilem Scanner.

## Start (NixOS)

```sh
nix develop          # oder: nix shell nixpkgs#nodejs_24
npm install
npm start            # http://localhost:3000
```

Beim ersten Start wird ein **Owner-Konto** angelegt und die Zugangsdaten werden
in der Konsole ausgegeben (Passwort via `OWNER_PASSWORD=… npm start` setzbar).
Die Datenbank liegt in `data/voreinlass.db` (SQLite, via `node:sqlite` — keine
nativen Module nötig).

> **Kamera:** Browser erlauben Kamerazugriff nur über HTTPS oder `localhost`.
> Für Scanner-Handys im LAN also einen Reverse-Proxy mit TLS (z. B. Caddy)
> davorschalten oder einen Tunnel nutzen.

## Rollen

| Rolle | Rechte |
|---|---|
| **Owner** | Events anlegen, Event-Admin-/Scanner-Konten erstellen und Events zuweisen |
| **Event-Admin** | Ausschließlich zuständig für die zugewiesenen Events: Abteilungen anlegen, UUIDs generieren, QR-Codes (ZIP/Druckansicht), Excel-Export, tägliche Reset-Zeit festlegen |
| **Scanner** | Scannen + Dashboard der zugewiesenen Events |

Abteilungen, UUIDs und QR-Codes verwaltet **nur** der Event-Admin — auch der
Owner hat auf diese Endpunkte keinen Zugriff.

**Kontowechsler:** Über den Bereich unten in der Seitenleiste können mehrere
Konten gleichzeitig angemeldet sein („Konto hinzufügen") und per Klick
gewechselt werden. Jedes Konto behält seine eigene Session (Bearer-Token).

## Ablauf

1. Als Owner anmelden → **Verwaltung**: Event anlegen, Konten anlegen, zuweisen.
2. Als Event-Admin: Abteilungen anlegen, pro Abteilung UUIDs
   erzeugen, QR-Codes drucken (jedes Label zeigt Abteilungsname + UUID),
   UUIDs als Excel exportieren, Reset-Zeit einstellen (Standard 00:00).
3. Scanner öffnen **Scannen** am Handy: Kamera scannt, Feedback:
   - **OK** (grün) mit laufender Scan-Nummer der Abteilung
   - **Doppelt** (orange) mit der UUID des bereits gescannten Codes
   - **Error** (rot) bei unbekanntem/ungültigem Code
4. **Dashboard**: Abteilungs- und Scan-Zähler (heute), Klick auf eine
   Abteilung zeigt die doppelt gescannten Codes mit UUIDs.

Die Tageszähler beziehen sich immer auf den Zeitraum seit der zuletzt
verstrichenen Reset-Zeit — der Reset erfolgt damit exakt zur konfigurierten
Uhrzeit, ohne Cronjob.

Doppelscan-Schutz: Der Client ignoriert erneute Reads desselben Codes für 6 s,
der Server wiederholt innerhalb von 5 s dieselbe OK-Antwort statt ein
„Doppelt" zu werten.

## API (Kurzüberblick)

```
POST   /api/login | /api/logout      GET /api/me
POST   /api/admin/users              GET/DELETE ebenso        (Owner)
POST   /api/admin/events             POST /api/admin/events/:id/assignments
PATCH  /api/events/:id               { reset_time: "HH:MM" }  (Event-Admin)
POST   /api/events/:id/sections
POST   /api/sections/:id/tickets     { count: n }
GET    /api/sections/:id/tickets
GET    /api/events/:id/tickets.xlsx
GET    /api/sections/:id/qrcodes.zip | /api/sections/:id/qrcodes/print
GET    /api/events/:id/dashboard     GET /api/sections/:id/doubles
POST   /api/scan                     { code: "<uuid>" }
```

## Tests

```sh
node --test test/api.test.mjs
```
