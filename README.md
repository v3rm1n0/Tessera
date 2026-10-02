# Tessera

Entry monitoring with roles, QR-code generation and a mobile scanner. Named after the *tessera*, a small token (clay, bone or metal) used in
ancient Rome as proof of identity or admission: to a grain ration, the
theatre, gladiatorial games, or as a badge of hospitality. Same idea here,
just digital: a token that gets someone through the door.

## Start (NixOS, dev only)

```sh
nix develop          # or: nix shell nixpkgs#nodejs_24 nixpkgs#bun
bun install
bun start            # http://localhost:3000
```

Bun is only the package manager (install + script runner); the app itself
runs on Node.js (it relies on `node:sqlite`).

Nix is only used for local development (via `flake.nix`); it is **not** the
deployment target. Production deploys target Debian — see
`deploy/tessera.service` for a ready-to-use systemd unit (Node.js via
NodeSource, an `/opt/tessera` checkout, a dedicated system user via
`DynamicUser`, and a `StateDirectory` for the database).

On first start an **owner account** is created and its credentials are
printed to the console (the password can be set via
`OWNER_PASSWORD=… bun start`). The database lives in `data/tessera.db`
(SQLite, via `node:sqlite` — no native modules required).

### Database migrations

The schema is managed through versioned, idempotent migrations in
`server/migrate.js` (table `schema_migrations`). The server applies any
pending migrations automatically on startup; to run them explicitly (e.g.
during a deploy):

```sh
bun run migrate                                       # locally
DATA_DIR=/var/lib/tessera node server/migrate.js    # on the server
```

The run is safe to repeat and also works against an already up-to-date
database (existing structures are skipped).

> **Camera:** browsers only allow camera access over HTTPS or `localhost`.
> For scanner phones on the LAN, put a TLS reverse proxy (e.g. Caddy) in
> front, or use a tunnel.

## Roles

| Role | Permissions |
|---|---|
| **Owner** | Administration only: create events, create Event Admin/Scanner accounts and assign them to events. **No** scanning and **no** dashboard. |
| **Event Admin** | Responsible for their assigned events: create sections (with color) and subsections, generate UUIDs, design and export admission cards, Excel export, set the daily reset time. Also sees the dashboard/scanner. |
| **Scanner** | Scanning + dashboard for the assigned events |

Sections, UUIDs and admission cards are managed **only** by the Event Admin —
the Owner has no access to those endpoints and lands directly in
Administration after login. The Owner creates accounts directly inside an
event (event tile → "+ Account") or assigns existing accounts to it.

**Section colors:** every section is automatically assigned a color from a
palette when created (or a custom one). It appears on the dashboard and is
the admission card's main color.

**Subsections:** sections can optionally have subsections (e.g. Security →
Entrance crew / Floor crew). In Administration each section appears as a
card that contains its subsections as nested cards — each level has its own
code counter and UUID generator. UUIDs are generated per level; the card
label and scan feedback then show "Section – Subsection".

**Admission cards:** the admission card is designed **once per event** —
background image, title and text (with `**bold**`) are freely editable. A
single export generates a card for **every UUID of every section**:
composited in the browser on a `<canvas>` (using the section's main color,
a QR code and "Section – Subsection"), bundled as PNGs in a ZIP file — one
folder per section, one subfolder per subsection
(`Section/Subsection/uuid.png`). The server only stores the configuration
(no native image module, no server-side QR library needed).

Optionally (checkbox in the export) each folder is bundled with a
`UUIDs.xlsx` listing just that section's/subsection's UUIDs plus an empty
"Name (recipient)" column — so section and subsection leads can tick off who
received which UUID.

**Account switcher:** the area at the bottom of the sidebar lets several
accounts be logged in at once ("Add account") and switched between with a
click. Each account keeps its own session (bearer token).

## Theme & language

Dark, light or system theme, and German/English language, are both
auto-detected on first load (system color scheme resp. browser language)
and can be switched at any time — on the login screen and in the
account-switcher menu. Preferences are stored per browser and apply
instantly, without a page reload.

## Flow

1. Sign in as Owner → **Administration**: create an event, create accounts,
   assign them.
2. As Event Admin: create sections (with color) and optionally subsections,
   generate UUIDs per level, design the admission card once and export all
   cards as a PNG ZIP, export UUIDs as Excel, set the reset time (default
   00:00).
3. Scanners open **Scan** on their phone: the camera scans, feedback is:
   - **OK** (green) with the section's running scan number
   - **Duplicate** (orange) with the UUID of the already-scanned code
   - **Error** (red) for an unknown/invalid code
4. **Dashboard**: section and scan counters (today), clicking a section
   shows the double-scanned codes with their UUIDs.

Daily counters always cover the period since the last elapsed reset time —
the reset happens exactly at the configured time, without a cron job.

Double-scan protection: the client ignores repeated reads of the same code
for 6 s; the server repeats the same OK response within 5 s instead of
counting it as a duplicate.

## API (overview)

```
POST   /api/login | /api/logout      GET /api/me
POST   /api/admin/users              GET/DELETE likewise             (Owner)
POST   /api/admin/events             POST /api/admin/events/:id/assignments
POST   /api/admin/events/:id/users   create account + assign         (Owner)
PATCH  /api/events/:id               { reset_time: "HH:MM" }         (Event Admin)
POST   /api/events/:id/sections      { name, color? }
PATCH  /api/sections/:id             { color }
POST   /api/sections/:id/subsections { name }
GET/DELETE subsections likewise
POST   /api/sections/:id/tickets     { count: n, subsection_id? }
GET    /api/sections/:id/tickets     GET /api/events/:id/tickets.xlsx
GET    /api/events/:id/card          PUT { title, text }             (once per event)
POST/GET/DELETE /api/events/:id/card/backdrop   (image upload, raw)
GET    /api/events/:id/card/tickets  flat list for the PNG export
GET    /api/events/:id/dashboard     GET /api/sections/:id/doubles   (event roles)
POST   /api/scan                     { code: "<uuid>" }              (event roles)
```

Errors are JSON of the form `{ "error": "<English text>", "code": "<CODE>" }`; the
web UI translates the `code` into the selected language.

Downloads and the card background are fetched with the bearer token and handed
to the browser from an in-memory blob, so the token never appears in a URL; all
calls authenticate via the bearer token or the session cookie.

## Owner password recovery

The credentials are only printed on the very first start (on the server:
`journalctl -u tessera | grep -A3 'Owner-Konto'`). Reset at any time
with:

```sh
node server/reset-owner.js [new-password]                # locally
DATA_DIR=/var/lib/tessera node server/reset-owner.js   # on the server (sudo)
```

Without an argument a random password is generated and printed. Existing
owner sessions are logged out in the process.

## Tests

```sh
bun run test
```

## License

Copyright © 2026 V3RM1N.

Tessera is **source-available**, not open source: it is licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE). You may use, modify and share
it for **any noncommercial purpose** (personal, charitable, educational,
research, government). **Commercial use requires a separate license** — contact
the copyright holder to arrange one.
