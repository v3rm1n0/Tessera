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
`OWNER_PASSWORD=… bun start`; passwords must be at least 8 characters, which
also applies to every account created later). The database lives in `data/tessera.db`
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

**Installing as an app:** over HTTPS (or on `localhost`) the browser offers to
install Tessera to the home screen (manifest + icons in `public/`). A service
worker (`public/sw.js`) keeps the app files in a cache: they open at once and are
refreshed in the background, so after an update the new version is used from the
second load on. Page loads go to the network first and fall back to the cached
shell when the network is down or does not answer within 4 seconds; the API is
never cached, so scanning still needs a connection (the scanner says so, and
nothing is recorded). When the server cannot be reached the app shows a retry
screen, stays signed in and tries again every 5 seconds. Add new files under `public/` to the list in
`public/sw.js` (a test fails until you do). The PNG icons are rendered from
`public/icons/*.svg`:

```sh
nix shell nixpkgs#librsvg -c rsvg-convert -w 192 -h 192 public/icons/icon.svg -o public/icons/icon-192.png
# likewise icon.svg -> icon-512.png and icon-maskable.svg -> icon-maskable-512.png at 512 px
```

## Configuration

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | TCP port |
| `HOST` | all interfaces | Bind address. Set `127.0.0.1` when a reverse proxy on the same machine is the only entry point (the shipped systemd unit does). |
| `TRUST_PROXY` | off | Trust the proxy's `X-Forwarded-For` header: `loopback`, a hop count (`1`), or a subnet list. Needed behind a proxy so login throttling sees real client addresses (the unit sets `loopback`). |
| `DATA_DIR` | `./data` | Directory of the SQLite database |
| `OWNER_PASSWORD` | random | Password of the initial owner account (at least 8 characters) |
| `BACKUP_DIR` | `<DATA_DIR>/backups` | Where `server/backup.js` puts database backups |
| `NODE_ENV` | | `production` marks the session cookie `Secure` (HTTPS only) |

Sessions expire after 12 hours of inactivity; using the app extends them, so a
scanner that is in use all day stays signed in.

Failed logins are throttled for 15 minutes: 8 failures per client address and
username, with higher backstops of 40 per username (any address) and 200 per
address (any username), so one mistyped password or one busy venue network
cannot lock everybody out.

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
label and scan feedback then show "Section – Subsection". Deleting a
subsection deletes its codes (and their scan history) too; the confirmation
names the number of codes.

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

**Archiving:** when an event is over, the Owner can archive it (and give it an
optional start and end date). An archived event is read-only: nothing is scanned
or changed any more, while the dashboard, history, scan log and exports stay
available. Archived events move out of the way in the event picker and can be
unarchived at any time.

**Passwords:** every user can change their own password (account menu → *Change
password*; other devices are signed out). The Owner can reset any account's
password (the form suggests a generated one to hand over), and new accounts get a
*Generate* button for the same. Passwords need at least 8 characters.

**Renaming:** the Owner can rename events and event admins can rename sections and
subsections (pencil next to the name); codes, scans and cards stay attached, and
scan labels pick up the new name immediately.

**Activity log:** administrative actions (accounts, events, assignments, sections,
subsections, code generation, deletions, event settings) are recorded with who did
them and shown to the Owner under Administration → Activity (`GET /api/admin/audit`).

**Holders and revoking:** a code can carry the holder's name (shown to the
scanner on every scan) and can be revoked, e.g. when a badge is lost. A
revoked code is refused with its own red "revoked" result and is not counted;
restoring it makes it valid again. Codes are searched by UUID fragment or name.
Names can also be imported: fill the "Name (recipient)" column of an exported
sheet (the Excel export, or the per-folder `UUIDs.xlsx` of the card export) and
upload it again (`POST /api/events/:id/holders`, Excel or CSV, German or English
headers, or simply a UUID column next to a name column).

**Manual entry:** every card prints a short code under the QR code (the first 12
hex digits of its UUID, e.g. `550E-8400-E29B`). When a QR code is damaged or the
camera will not read it, the scanner taps the keyboard button and types the short
code. `POST /api/scan` accepts a whole UUID or any start of at least 12 digits
(case, spaces and dashes are ignored). A start is only looked up among the
scanner's own events, and one that fits several codes is refused as ambiguous.

**Undoing a scan:** a scanner can take back their own scan for a minute after
making it (`POST /api/scans/:id/void`), event admins can void any scan of their
events. Voided scans stop counting everywhere, and the code can be scanned again;
scan numbers are never reused within a day. A duplicate result also shows who
scanned the code first.

On the dashboard every section with subsections also shows how far each
subsection is (scans today / codes issued).

**History:** the *History* view lists every event day (from one reset time to the
next, in the event's time zone) with its scan total, duplicates, the activity per
section and a bar chart of entries per hour — yesterday's numbers no longer
disappear at the reset.

**Codes view:** event admins find any code by UUID fragment or holder name,
filter by section or state, edit holder names inline, revoke or restore codes,
open a code's scan history (and undo single scans) and import names from a sheet.

**Scan log:** event admins get a searchable log of every scan (who, when, which
code, result, voided scans struck through), filterable by result and event day,
with an Excel export of exactly what is filtered (`GET /api/events/:id/scans.xlsx`).

**Account switcher:** the area at the bottom of the sidebar lets several
accounts be logged in at once ("Add account") and switched between with a
click. Each account keeps its own session (bearer token).

## Theme & language

Dark, light or system theme, and German/English language, are both
auto-detected on first load (system color scheme resp. browser language)
and can be switched at any time — on the login screen and in the
account-switcher menu. Preferences are stored per browser and apply
instantly, without a page reload.

## Performance

Text-like responses above 1 KB (scripts, styles, JSON lists) are gzip-compressed (`compression`);
files that are compressed already (xlsx, png, woff2) are not. Fonts are cached by browsers for a week
and the vendored scripts for a day; the app's own files are revalidated on every load.

## Vendored libraries

`public/vendor/` holds the browser copies of jsQR, JSZip and qrcode-generator (the app has no
build step). They are copied from `node_modules`: after `bun update` run `bun run vendor` to refresh
them; `bun run vendor -- --check` only reports. The test suite fails when a copy has drifted.

## Health check

`GET /healthz` needs no login and answers `{"status":"ok","version":"…","uptime":<seconds>}` (HTTP 200, never
cached), or `{"status":"error"}` with HTTP 503 when the database does not answer a query. Point a
load balancer or uptime monitor at it, e.g. `curl -fsS http://127.0.0.1:3000/healthz`.

## Backups

`bun run backup` (or `node server/backup.js [dir] [--keep N]`) copies the database while the
app keeps running, as `tessera-YYYYMMDD-HHMMSS.db` (UTC) into `dir`, else `$BACKUP_DIR`, else
`<DATA_DIR>/backups`, and keeps the newest `N` (default 14) of those files; nothing else in the
folder is touched. The copy is one consistent snapshot even while scans are being recorded, is
checked with `PRAGMA integrity_check` before it replaces anything, and is private (folder 0700,
file 0600). Under systemd, `deploy/tessera-backup.timer` runs it every night at 03:30 (see the
header of `deploy/tessera-backup.service` for installation and for restoring); copy the files off
the machine as well, a backup on the same disk does not survive losing the disk.

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
the reset happens exactly at the configured time, without a cron job. The reset
time is read on the wall clock of the event's own **time zone** (set next to the
reset time; new events start in the server's zone), so a server running in UTC
resets a Berlin event at Berlin midnight. Days around daylight-saving changes
are 23 or 25 hours long. Changing the reset time or zone moves the current day
window, so the app asks for confirmation.

Double-scan protection: the client ignores repeated reads of the same code
for 6 s; the server repeats the same OK response within 5 s instead of
counting it as a duplicate.

## API (overview)

```
POST   /api/login | /api/logout      GET /api/me
POST   /api/admin/users              GET/DELETE likewise             (Owner)
POST   /api/admin/events             POST /api/admin/events/:id/assignments
POST   /api/admin/events/:id/users   create account + assign         (Owner)
PATCH  /api/admin/users/:id          { password }                    (Owner) reset a password
POST   /api/me/password              { current, next }               any user, changes own password
PATCH  /api/admin/events/:id         { name?, start_date?, end_date?, archived? }    (Owner)
PATCH  /api/events/:id               { reset_time: "HH:MM" }         (Event Admin)
POST   /api/events/:id/sections      { name, color? }
PATCH  /api/sections/:id             { name?, color? }
PATCH  /api/subsections/:id          { name }
POST   /api/sections/:id/subsections { name }
GET/DELETE subsections likewise
POST   /api/sections/:id/tickets     { count: n, subsection_id? }
GET    /api/sections/:id/tickets     GET /api/events/:id/tickets.xlsx
GET    /api/events/:id/tickets       ?q=&section=&subsection=&status=&limit=&offset=   (Event Admin)
PATCH  /api/tickets/:uuid            { holder?, revoked? }                           (Event Admin)
POST   /api/events/:id/holders       raw .xlsx or .csv body, fills in holder names    (Event Admin)
POST   /api/scans/:id/void           take back a scan (own scan within 60 s; admins: any)
GET    /api/events/:id/card          PUT { title, text }             (once per event)
POST/GET/DELETE /api/events/:id/card/backdrop   (image upload, raw)
GET    /api/events/:id/card/tickets  flat list for the PNG export
GET    /api/events/:id/dashboard     GET /api/sections/:id/doubles   (event roles)
GET    /api/events/:id/history       per-day totals, sections and hourly throughput (event roles)
GET    /api/events/:id/scans         ?limit=&before=&result=&q=&day=                  (Event Admin) scan log
GET    /api/events/:id/scans.xlsx    ?day=&lang=de|en                                 (Event Admin) attendance sheet
GET    /api/tickets/:code            full uuid or its first 12+ hex digits            (Event Admin) code + scan history
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
