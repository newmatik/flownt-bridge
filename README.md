# Flownt Bridge

Connects your 3D printers to Flownt in real time — live status, temperatures, progress, and automatic print log entries. It can also act as a local label-printing helper (Dymo) for Flownt.

Current version: **0.9.5** (see `src/version.ts`).

## Supported Printers

| Printer | Status |
|---|---|
| Bambu Lab (X1, P1, A1, H2D, …) — MQTT + FTPS | ✅ (incl. AMS, pause/resume/stop) |
| Klipper / Moonraker — HTTP | ✅ (read-only) |
| Prusa Link (MK4, XL, MINI, Core One) — HTTP | ✅ read-only, since v0.5.0 |
| Anycubic Kobra (X, S1) | 🧪 Spike on branch `spike/anycubic-lan`, not in releases |
| OctoPrint | 🔜 Planned |

Optional per printer: a **Shelly** smart plug (Gen 1–4) for real power/energy metering, and
**Bambu Cloud** credentials as a fallback source for filament weight.

---

## Installation

### Option A – Ein Befehl (empfohlen)

Erkennt System & Architektur automatisch, lädt die passende Binary, löst die
Sicherheits-Sperre (macOS-Quarantäne / Windows-SmartScreen), richtet **Autostart**
ein und startet die Bridge. Erneut ausführen = auf neueste Version aktualisieren.

**macOS & Linux (Raspberry Pi / Mini-PC):**
```bash
curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.sh | bash
```
*(Für einen System-Dienst auf dem Raspberry Pi stattdessen `… | sudo bash` — siehe unten.)*

**Windows** (PowerShell):
```powershell
irm https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.ps1 | iex
```

Danach öffnet sich die Web-Oberfläche unter **http://localhost:7432** — dort wählst du,
was diese Bridge tun soll (Drucker überwachen / Etiketten drucken).

---

### Option B – Binary manuell

Datei für dein System aus den [Releases](https://github.com/Buba2017/flownt-bridge/releases/latest) laden:

| System | Datei |
|---|---|
| Mac (Apple Silicon / M1–M4) | `flownt-bridge-macos-arm64` |
| Mac (Intel) | `flownt-bridge-macos-x64` |
| Windows | `flownt-bridge-win-x64.exe` |
| Raspberry Pi (64-bit) | `flownt-bridge-linux-arm64` |
| Linux PC (64-bit) | `flownt-bridge-linux-x64` |

**Mac** — einmalig im Terminal ausführbar machen + Quarantäne lösen:
```bash
chmod +x flownt-bridge-macos-arm64 && xattr -d com.apple.quarantine flownt-bridge-macos-arm64
```
**Windows** — `.exe` doppelklicken. Bei SmartScreen-Warnung: **„Weitere Informationen" → „Trotzdem ausführen"**.

---

### Option C – Aus dem Quellcode (Node.js 18+, empfohlen 20)

```bash
git clone https://github.com/Buba2017/flownt-bridge.git
cd flownt-bridge && npm install && npm start
```

Die Web-UI läuft auf Port **7432**; ein anderer Port lässt sich per Umgebungsvariable
`FLOWNT_BRIDGE_PORT` setzen. Die Konfiguration liegt in `~/.flownt-bridge/config.json`
(wird über die Web-UI gepflegt, nicht von Hand).

---

## Setup

Open `http://localhost:7432` (on a fresh install with a desktop the browser opens it automatically).
A fresh bridge first asks for its role — **monitor printers**, **print labels**, or **both** — then
leads you to **Settings → + Printer**.

### Flownt Auth Token

1. Open Flownt in another browser tab
2. Go to **Printers & Devices**
3. Click your printer → **Edit**
4. Scroll to **"Bridge Connection"**
5. Click **"Copy"** next to the token
6. Paste it into the token field

### Bambu Lab

Find all three values on the printer display under **Settings → Network**:

| Field | Example |
|---|---|
| IP Address | `192.168.1.100` |
| Serial Number | `00M09A123456789` |
| Access Code | `dc00ce26` |

> The printer does **not** need to be in LAN-only mode. It can stay connected to the Bambu app.

### Moonraker / Klipper

| Field | Description | Example |
|---|---|---|
| Printer URL | IP address of your Raspberry Pi | `http://192.168.1.100` |
| API Key | Only if configured in Moonraker (usually leave empty) | |

Click **"Save & Connect"**. The page switches to the status view — a green dot means the printer is connected.

### Prusa Link

| Field | Description | Example |
|---|---|---|
| Printer URL | IP address of the printer | `http://192.168.1.100` |
| API Key | From the printer display: **Settings → Network → PrusaLink** | |

Read-only: live status, progress, temperatures, ETA, and automatic print logs with filament usage on completion. Filament weight is parsed from the print file (`.gcode` / `.bgcode`, best-effort).

---

## Raspberry Pi — Autostart (empfohlen)

Für den Dauerbetrieb auf einem Raspberry Pi (64-bit Raspberry Pi OS, z. B. Pi 3/4/5 oder
Zero 2 W) den Ein-Befehl-Installer **als root** ausführen:

```bash
curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/install.sh | sudo bash
```

Der Installer:
- lädt die fertige Binary (`flownt-bridge-linux-arm64`) aus den Releases — Node.js wird **nicht** benötigt
- legt sie nach `/opt/flownt-bridge/`
- richtet einen systemd-System-Dienst ein (startet beim Boot, Neustart bei Absturz) und startet ihn

Ohne `sudo` wird stattdessen ein systemd-User-Dienst unter `~/.flownt-bridge/` eingerichtet.
Ein 32-bit-OS wird nicht unterstützt (es gibt kein `linux-armv7`-Release).

Danach erreichbar unter `http://<Pi-IP-Adresse>:7432` — im Browser auf jedem Gerät im Heimnetz.

```bash
journalctl -fu flownt-bridge          # Live-Logs
sudo systemctl stop flownt-bridge     # Stoppen
sudo systemctl restart flownt-bridge  # Neustarten
```

**Update:** denselben Installer-Befehl erneut ausführen.
**Entfernen** (System-Dienst):
```bash
curl -fsSL https://raw.githubusercontent.com/Buba2017/flownt-bridge/main/uninstall.sh | sudo bash
```
Die Konfiguration in `~/.flownt-bridge/` bleibt erhalten.

---

## Mac/Windows — Keep the Bridge running (optional)

Only needed for Option B/C — the one-line installer (Option A) already sets up autostart.
A manually started binary or `npm start` only runs while its window is open.

```bash
npm install -g pm2
# Binary:
pm2 start ./flownt-bridge-macos-arm64 --name flownt-bridge
# or npm:
pm2 start "npm start" --name flownt-bridge
pm2 save
pm2 startup
```

Run the last printed command (starts with `sudo`) to enable autostart on boot.

```bash
pm2 status          # check status
pm2 stop flownt-bridge
```

---

## FAQ

**The bridge shows a connection error.**
- Make sure the printer is on and in the same network as the computer running the bridge
- Check IP address, serial number and access code
- Open http://localhost:7432/setup and re-enter the credentials

**Where is the bridge status page?**
While the bridge is running: **http://localhost:7432**

**I generated a new token in Flownt. What now?**
Open http://localhost:7432/setup, enter the new token and save.

**Does it work if the printer is on a different network?**
No — the bridge and printer must be on the same local network.

---

## Status Page

While the bridge is running, open **http://localhost:7432** (or `http://<Pi-IP>:7432` on Raspberry Pi).

The status page shows:

| Section | Details |
|---|---|
| Printer status | idle / printing / paused / error / offline with filename, progress %, temperatures |
| AMS slots | Color circles per slot, material name, remaining %, active slot highlighted |
| ETA | Formatted remaining print time (e.g. `1h 23m`) |
| AMS humidity | Humidity level (1–5, 5=dry) + real relative humidity % (from `ams.humidity_raw`) + temperature per AMS unit |
| Events | Last 8 events (the bridge keeps 30 per printer, see `/api/state`), color-coded: ✓ green (success) · ℹ gray (info) · ⚠ orange (warning) |

The page auto-refreshes every 8 seconds.

**Events logged automatically:**
- `✓ Verbindung zu Flownt hergestellt` — on startup
- `✓ Drucker verbunden: <IP>` — when MQTT connects
- `ℹ Druck gestartet: <filename>` — when a print begins
- `✓ Druckdatei geladen: <filename> (N Slot(s))` — when FTPS file download succeeds
- `⚠ Druckdatei nicht via FTPS gefunden` — when all FTPS paths fail
- `✓ Drucklog erstellt: <filename>` — after job_complete lands in Flownt
- `⚠ Druck abgebrochen/fehlgeschlagen — kein Materialabzug` — on job_failed

**JSON API:**
- `GET /api/state` — printer snapshots + event log as JSON
- `GET /api/version` — `{ "version": "x.y.z" }`
- `POST /printer/command` — `{ "type": "pause" | "resume" | "stop", "printerId"?: "…" }` (Bambu only)

---

## Dymo Label Printing

The bridge enables direct label printing from the browser, bypassing Dymo Connect CORS restrictions.

1. Flownt sends the print job to `http://localhost:7432/dymo/print`
2. The bridge tries the Dymo Connect REST API first (port 41951)
3. If that fails: automatic fallback via the CUPS driver (`lp`; the PNG is resized with `sips`, so this fallback is **macOS-only**)

**Requirements for CUPS fallback:**
- Dymo LabelWriter set up in macOS System Settings → Printers
- Dymo Connect must be running (needed for printer name detection)

**If the printer goes offline after an error:**
1. Open System Settings → Printers & Scanners
2. Select DYMO LabelWriter → Open print queue
3. Delete stuck jobs → reactivate printer

---

## Architecture

```
Printer (LAN)  ←MQTT/FTPS/HTTP→  Flownt Bridge (local)  ←HTTPS→  Flownt Cloud
Browser        ←HTTP→            Flownt Bridge (port 7432) → CUPS → Label printer
```

The bridge initiates all connections outbound. No ports need to be opened on your router.
The web UI listens on all interfaces (port 7432) so a headless Pi can be configured from another
device — keep it inside your LAN. Data contract and event derivation: see [CONTEXT.md](CONTEXT.md).

---

## Development

```bash
npm install
npm start              # run from source (tsx)
npm run dev            # same, with watch mode
npm test               # unit tests (Vitest)
npm run typecheck      # tsc --noEmit
npm run build          # bundle to dist/bundle.cjs (esbuild)
npm run package        # standalone binaries for all platforms (pkg)
npm run package:mac    # macOS arm64 only (faster)
```

Binaries are written to `dist/`.

- `src/contract.ts` is a **generated copy** from the main Flownt repo — never edit it here.
- On a release bump the version in **both** `package.json` and `src/version.ts`.
