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
| **Owner** | Nur Verwaltung: Events anlegen, Event-Admin-/Scanner-Konten erstellen und Events zuweisen. **Kein** Scannen und **kein** Dashboard. |
| **Event-Admin** | Zuständig für die zugewiesenen Events: Abteilungen (mit Farbe) und Unterabteilungen anlegen, UUIDs generieren, QR-Codes (ZIP/Druckansicht), Einlasskarten gestalten, Excel-Export, tägliche Reset-Zeit festlegen. Sieht auch Dashboard/Scanner. |
| **Scanner** | Scannen + Dashboard der zugewiesenen Events |

Abteilungen, UUIDs, QR-Codes und Einlasskarten verwaltet **nur** der
Event-Admin — der Owner hat auf diese Endpunkte keinen Zugriff und landet nach
dem Login direkt in der Verwaltung. Der Owner legt Konten direkt im jeweiligen
Event an (Event-Kachel → „+ Konto") oder weist bestehende Konten zu.

**Abteilungsfarben:** Jede Abteilung erhält beim Anlegen automatisch eine
Farbe aus einer Palette (oder eine selbst gewählte). Sie erscheint im Dashboard
und ist die Hauptfarbe der Einlasskarte.

**Unterabteilungen:** Abteilungen können optional Unterabteilungen haben
(z. B. Ordnungsdienst → Eingangsordner / Innenraum Ordner). UUIDs werden
wahlweise für eine Unterabteilung erzeugt; QR-Label und Scan-Feedback zeigen
dann „Abteilung – Unterabteilung".

**Einlasskarten:** Pro Abteilung lässt sich eine druckbare Einlasskarte
gestalten — Hintergrundbild, Titel und Text sind frei wählbar, die Hauptfarbe
kommt aus der Abteilung. Die Karten werden im Browser auf einem `<canvas>`
zusammengesetzt (QR-Code + „Abteilung – Unterabteilung" pro UUID) und in großer
Stückzahl als PNG in einer ZIP-Datei exportiert. Der Server speichert nur die
Konfiguration (kein natives Bildmodul nötig).

**Kontowechsler:** Über den Bereich unten in der Seitenleiste können mehrere
Konten gleichzeitig angemeldet sein („Konto hinzufügen") und per Klick
gewechselt werden. Jedes Konto behält seine eigene Session (Bearer-Token).

## Ablauf

1. Als Owner anmelden → **Verwaltung**: Event anlegen, Konten anlegen, zuweisen.
2. Als Event-Admin: Abteilungen (mit Farbe) und optional Unterabteilungen
   anlegen, pro Abteilung/Unterabteilung UUIDs erzeugen, QR-Codes drucken
   (jedes Label zeigt „Abteilung – Unterabteilung" + UUID), Einlasskarten
   gestalten und als PNG-ZIP exportieren, UUIDs als Excel exportieren,
   Reset-Zeit einstellen (Standard 00:00).
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
POST   /api/admin/users              GET/DELETE ebenso            (Owner)
POST   /api/admin/events             POST /api/admin/events/:id/assignments
POST   /api/admin/events/:id/users   Konto anlegen + zuweisen     (Owner)
PATCH  /api/events/:id               { reset_time: "HH:MM" }      (Event-Admin)
POST   /api/events/:id/sections      { name, color? }
PATCH  /api/sections/:id             { color }
POST   /api/sections/:id/subsections { name }
GET/DELETE Unterabteilungen ebenso
POST   /api/sections/:id/tickets     { count: n, subsection_id? }
GET    /api/sections/:id/tickets     GET /api/events/:id/tickets.xlsx
GET    /api/sections/:id/qrcodes.zip | /api/sections/:id/qrcodes/print
GET    /api/sections/:id/card        PUT { title, text }
POST/GET/DELETE /api/sections/:id/card/backdrop   (Bild-Upload, raw)
GET    /api/events/:id/dashboard     GET /api/sections/:id/doubles  (Event-Rollen)
POST   /api/scan                     { code: "<uuid>" }             (Event-Rollen)
```

Download-/Bild-Links tragen den Session-Token als `?token=` (da `<a>`/`<img>`
keine Header senden); alle anderen Aufrufe nutzen das Bearer-Token bzw. Cookie.

## Owner-Passwort vergessen?

Die Zugangsdaten werden nur beim allerersten Start ausgegeben
(auf dem Server: `journalctl -u voreinlass | grep -A3 'Owner-Konto'`).
Zurücksetzen jederzeit mit:

```sh
node server/reset-owner.js [neues-passwort]          # lokal
DATA_DIR=/var/lib/voreinlass node server/reset-owner.js   # auf dem Server (sudo)
```

Ohne Argument wird ein zufälliges Passwort erzeugt und angezeigt.
Bestehende Owner-Sessions werden dabei abgemeldet.

## Tests

```sh
node --test test/api.test.mjs
```
