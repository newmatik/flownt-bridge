import mqtt from 'mqtt';
import { Client as FTPClient, FileInfo } from 'basic-ftp';
import { Writable } from 'stream';
import { Adapter, AmsHumidityUnit, AmsSlot, FilamentWeight, JobResult, PrinterCommand, PrinterSnapshot, PrinterStatus } from './types.js';
import { parseFileBuffer } from './bambu-file-parser.js';
import { addEvent } from '../events.js';

interface BambuAmsTray {
  id?: string;
  tray_type?: string;
  tray_color?: string;  // Bambu sendet "0xFFAA00FF" (RRGGBBAA) oder "0xFFAA00"
  remain?: number;
  tray_weight?: number;
}

interface BambuAmsUnit {
  id?: string;
  humidity?: string;     // "1"–"5" Trockenheits-Stufe (5=trocken, 1=feucht)
  humidity_raw?: string; // echte rel. Luftfeuchte in % (z.B. "24") — genau das liest auch HA
  temp?: string;         // "28.7" (°C, Innentemperatur der AMS-Einheit)
  tray?: BambuAmsTray[];
}

interface BambuHms {
  attr: number;
  code: number;
}

export interface BambuPrint {
  command?: string;  // "push_status", "gcode_line", "project_file", …
  gcode_state?: string;
  mc_percent?: number;
  mc_remaining_time?: number; // in minutes
  nozzle_temper?: number;
  bed_temper?: number;
  subtask_name?: string;
  subtask_id?: string; // eindeutige Job-ID (stabil je Druck; bei Re-Emission desselben Jobs gleich) — Dedup
  job_id?: string;     // Fallback-Job-ID
  gcode_file?: string; // absoluter Pfad auf dem Drucker, z.B. "/data/Metadata/plate_1.gcode"
  file?: string;       // alternatives Feld, gleiches Format
  hms?: BambuHms[];
  ams?: {
    ams?: BambuAmsUnit[];
    tray_now?: number | string; // aktiver Slot (globaler Index: ams_unit*4 + slot); Bambu sendet manchmal string
  };
  mapping?: number[]; // Slicer-Filament-id (1-basiert, Index = id-1) → physischer Tray-Code; 65535 = ungenutzt/extern
}

interface BambuReport {
  print?: BambuPrint;
}

export function mapState(state: string): PrinterStatus {
  switch (state.toUpperCase()) {
    case 'RUNNING': return 'printing';
    case 'PAUSE':   return 'paused';
    case 'FAILED':  return 'error';
    case 'IDLE':
    case 'FINISH':
    case 'CREATED':
    default:        return 'idle';
  }
}

// Normalisierter Job-Ausgang aus gcode_state. FINISH = sauber beendet, FAILED = Fehler bzw.
// manueller Stop (die Firmware meldet beim Stop aktuell FAILED). Sonst kein Terminal → null.
export function mapJobResult(state: string): JobResult | null {
  switch (state.toUpperCase()) {
    case 'FINISH': return 'completed';
    case 'FAILED': return 'failed';
    default:       return null;
  }
}

export function normalizeColor(raw?: string): string {
  if (!raw) return '#888888';
  // Bambu sendet "0xFFAA00FF" (mit Alpha) oder "0xFFAA00" → "#FFAA00"
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw.replace('#', '');
  // Nimm nur die ersten 6 Zeichen (RGB, ohne Alpha)
  return '#' + hex.slice(0, 6).toUpperCase();
}

export function parseAmsSlots(ams?: BambuPrint['ams']): AmsSlot[] {
  if (!ams?.ams?.length) return [];
  return ams.ams.flatMap((unit, amsUnit) =>
    (unit.tray ?? []).map((tray, slot) => ({
      ams_unit: amsUnit,
      slot,
      material: tray.tray_type ?? '',
      color: normalizeColor(tray.tray_color),
      remain: tray.remain ?? 0,
      tray_weight: tray.tray_weight ?? 1000,
    }))
  );
}

export function parseAmsHumidity(ams?: BambuPrint['ams']): AmsHumidityUnit[] {
  if (!ams?.ams?.length) return [];
  return ams.ams
    .map((unit, amsUnit): AmsHumidityUnit => {
      const pct = parseInt(unit.humidity_raw ?? '', 10);
      return {
        ams_unit: amsUnit,
        humidity: parseInt(unit.humidity ?? '0', 10),
        temp: parseFloat(unit.temp ?? '0'),
        humidity_pct: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : undefined,
      };
    })
    .filter(u => u.humidity > 0);
}

// tray_now kommt als Zahl oder String; Unsinn (NaN) nicht als aktiven Slot übernehmen.
function parseTrayNow(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

// Bambu kennt für lokale/SD-Drucke keine Job-ID und meldet dann "0" bzw. "" — das darf
// nicht als ID durchgehen, sonst dedupt das Backend alle diese Drucke gegeneinander.
function parseJobId(p: BambuPrint): string | undefined {
  for (const raw of [p.subtask_id, p.job_id]) {
    const id = raw == null ? '' : String(raw).trim();
    if (id && id !== '0') return id;
  }
  return undefined;
}

const isActive = (s: PrinterStatus) => s === 'printing' || s === 'paused';

/**
 * Merged eine MQTT-`print`-Nachricht in den bisherigen Snapshot (rein, ohne Seiteneffekte).
 * Bambu sendet Teil-Updates (v. a. P1/A1): fehlende Felder bedeuten „unverändert", NICHT
 * „leer". Ein fehlendes gcode_state behält daher den zuletzt gemeldeten Status (sonst
 * würde ein Delta mitten im Druck als IDLE → Job-Ende gewertet); nur ein leerer String
 * (Idle-push_status) heißt IDLE.
 *
 * `reportedStatus` = zuletzt vom Drucker gemeldeter Status (nie `offline`), damit ein
 * Reconnect mitten im Druck nicht als neuer Druck zählt.
 */
export function applyReport(
  prev: PrinterSnapshot,
  reportedStatus: PrinterStatus,
  p: BambuPrint,
): { snapshot: PrinterSnapshot; status: PrinterStatus; isNewPrint: boolean } {
  const hasState = typeof p.gcode_state === 'string';
  const status = hasState ? mapState(p.gcode_state || 'IDLE') : reportedStatus;
  const isNewPrint = !isActive(reportedStatus) && isActive(status);

  const trayNow = parseTrayNow(p.ams?.tray_now);
  const amsSlots = parseAmsSlots(p.ams);
  const amsHumidity = parseAmsHumidity(p.ams);
  const jobId = parseJobId(p);

  const snapshot: PrinterSnapshot = {
    status,
    jobResult: hasState ? mapJobResult(p.gcode_state || 'IDLE') : prev.jobResult,
    printFile: p.subtask_name !== undefined ? (p.subtask_name || undefined) : prev.printFile,
    sourceJobId: jobId ?? (isNewPrint ? undefined : prev.sourceJobId),
    progressPct: p.mc_percent ?? prev.progressPct,
    tempHotend: p.nozzle_temper ?? prev.tempHotend,
    tempBed: p.bed_temper ?? prev.tempBed,
    etaSec: p.mc_remaining_time != null ? p.mc_remaining_time * 60 : prev.etaSec,
    amsSlots: amsSlots.length > 0 ? amsSlots : prev.amsSlots,
    // Sticky: tray_now fehlt in den meisten Deltas. Ohne Carry-forward fiele der aktive
    // Slot (auch 254 = externe Spule) in der Anzeige ständig auf „unbekannt" zurück.
    activeMqttSlot: trayNow ?? prev.activeMqttSlot,
    amsHumidity: amsHumidity.length > 0 ? amsHumidity : prev.amsHumidity,
    // Mapping und Gewichte sind JOB-Zustand: bei neuem Druck verwerfen. Sonst erbt ein
    // Druck OHNE eigenes Mapping (externe Spule!) das Mapping des Vordrucks und der
    // Verbrauch wird dessen AMS-Slot zugeordnet (v0.9.4).
    filamentMapping: (Array.isArray(p.mapping) && p.mapping.length > 0) ? p.mapping : (isNewPrint ? undefined : prev.filamentMapping),
    parsedFilamentWeights: isNewPrint ? null : prev.parsedFilamentWeights,
  };
  return { snapshot, status, isNewPrint };
}


class BufferWritable extends Writable {
  private chunks: Buffer[] = [];
  _write(chunk: Buffer, _enc: string, cb: () => void) { this.chunks.push(chunk); cb(); }
  getBuffer(): Buffer { return Buffer.concat(this.chunks); }
}

// Leerzeichen und Unterstriche gleichsetzen: Bambu Studio bereinigt beim Senden
// "Modell v3" → "Modell_v3" (liegt in /cache/), ein SD-Start meldet aber den
// Originalnamen mit Leerzeichen. So matchen beide Schreibweisen.
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, '_');
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

// Reconnect-Backoff: A1/P1 bedienen lokal effektiv nur EINEN MQTT-Client; jeder
// fehlgeschlagene Versuch hinterlässt druckerseitig eine halb-offene Verbindung, die
// den Slot bis zum TCP-Keepalive-Timeout (~20 min) blockieren kann. Aggressives
// 5s-Dauerfeuer (alt) ist der dokumentierte Auslöser dafür (BambuStudio#2404,
// ha-bambulab#174) — daher ansteigender Abstand.
const RECONNECT_MIN_MS = 15_000;
const RECONNECT_MAX_MS = 120_000;
// Verbunden, aber keine Push-Daten mehr: dokumentiertes Firmware-Verhalten, wenn ein
// zweiter Client (Bambu Handy/Studio) die Verbindung übernimmt — die alte bleibt
// offen, bekommt aber nichts mehr. Der Watchdog erkennt das und baut sauber neu auf.
const DATA_SILENCE_MS  = 5 * 60_000;
const WATCHDOG_TICK_MS = 60_000;

export class BambuAdapter implements Adapter {
  private ip: string;
  private serial: string;
  private accessCode: string;
  private printerId: string;
  private connected = false;
  private snapshot: PrinterSnapshot = { status: 'offline' };
  private client: mqtt.MqttClient | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private lastHumSig = ''; // für ein Log nur bei Änderung der AMS-Feuchte
  private disposed = false;
  // Zuletzt vom Drucker gemeldeter Status (nie offline) — Basis für Teil-Updates und
  // die Neu-Druck-Erkennung über Reconnects hinweg.
  private reportedStatus: PrinterStatus = 'idle';
  private printGeneration = 0; // je neuem Druck erhöht; verwirft verspätete FTPS-Ergebnisse

  constructor(ip: string, serial: string, accessCode: string, printerId = '') {
    this.ip = ip.replace(/^https?:\/\//, '');
    this.serial = serial;
    this.accessCode = accessCode;
    this.printerId = printerId;
    this.connect();
    this.watchdog = setInterval(() => this.checkDataSilence(), WATCHDOG_TICK_MS);
  }

  /** Adapter vollständig stoppen (Config-Änderung/Löschen) — sonst reconnectet der
   *  alte MQTT-Client ewig weiter und kämpft mit dem neuen um den einzigen Slot. */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.watchdog)       { clearInterval(this.watchdog);      this.watchdog = null; }
    this.teardownClient();
    this.connected = false;
  }

  /** Alten Client restlos abbauen, bevor ein neuer verbindet — halb-offene
   *  Verbindungen blockieren am A1/P1 den lokalen MQTT-Slot. */
  private teardownClient(): void {
    if (!this.client) return;
    this.client.removeAllListeners();
    try { this.client.end(true); } catch { /* ignore */ }
    this.client = null;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    console.log(`[bambu] Reconnect in ${delay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private checkDataSilence(): void {
    if (this.disposed || !this.connected || this.lastMessageAt === 0) return;
    const silentMs = Date.now() - this.lastMessageAt;
    if (silentMs < DATA_SILENCE_MS) return;
    const min = Math.round(silentMs / 60_000);
    console.warn(`[bambu] ${min} min keine Daten trotz Verbindung — Neuaufbau`);
    addEvent(this.printerId, 'warn',
      `${min} min keine Druckerdaten trotz Verbindung — Neuaufbau. (Evtl. hat ein anderes Gerät die Drucker-Verbindung übernommen, z. B. Bambu Handy/Studio)`);
    this.connected = false;
    this.snapshot = { ...this.snapshot, status: 'offline' };
    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    this.teardownClient();
    this.client = mqtt.connect(`mqtts://${this.ip}:8883`, {
      username: 'bblp',
      password: this.accessCode,
      rejectUnauthorized: false,
      reconnectPeriod: 0,       // kein Auto-Reconnect — manueller Backoff (scheduleReconnect)
      connectTimeout: 15_000,
      keepalive: 30,            // tote Verbindungen schneller erkennen (Default 60 s)
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      this.lastMessageAt = Date.now();
      // Status bleibt bis zum ersten Report (pushall-Antwort) unverändert: ein
      // vorläufiges „idle" mitten im Druck sähe für die Bridge wie ein Job-Ende aus.
      console.log('[bambu] MQTT connected →', this.ip);
      addEvent(this.printerId, 'success', `Drucker verbunden: ${this.ip}`);
      this.client!.subscribe(`device/${this.serial}/report`, err => {
        if (err) console.error('[bambu] Subscribe error:', err.message);
      });
      // Ask printer for a full state push so the snapshot is current immediately
      this.client!.publish(
        `device/${this.serial}/request`,
        JSON.stringify({ pushing: { command: 'pushall', sequence_id: '0' } }),
        { qos: 0 },
        (err) => { if (err) console.error('[bambu] pushall error:', err.message); },
      );
    });

    this.client.on('message', (_topic, payload) => {
      this.lastMessageAt = Date.now();
      try {
        const raw = payload.toString();
        const msg = JSON.parse(raw) as BambuReport;
        const p = msg.print;
        if (!p) return;

        // push_status = periodic full-state push (gcode_state may be "" when printer is idle)
        const isPushStatus = p.command === 'push_status';

        if (!isPushStatus) {
          // All command responses — log regardless of whether gcode_state is present
          console.log('[bambu] Printer response:', raw.slice(0, 800));
          if (!p.gcode_state) return; // no state to update
        }

        const prevStatus = this.reportedStatus;
        const { snapshot, status: newStatus, isNewPrint } = applyReport(this.snapshot, prevStatus, p);

        if (newStatus !== prevStatus) {
          console.log(`[bambu] State: ${p.gcode_state} → ${newStatus} (${p.mc_percent ?? '-'}%)`);
          if (p.gcode_state === 'FAILED' || p.gcode_state === 'RUNNING') {
            console.log('[bambu] Full status:', raw.slice(0, 20000));
          }
          if (p.hms?.length) {
            console.log('[bambu] HMS warnings:', JSON.stringify(p.hms));
          }
        }

        const humSig = (snapshot.amsHumidity ?? []).map(u => `${u.ams_unit}:${u.humidity}/5${u.humidity_pct != null ? `/${u.humidity_pct}%` : ''}`).join(' ');
        if (humSig && humSig !== this.lastHumSig) {
          this.lastHumSig = humSig;
          console.log('[bambu] AMS Feuchte:', humSig);
        }

        this.reportedStatus = newStatus;
        this.snapshot = snapshot;
        if (isNewPrint) this.printGeneration++;

        // Bei Druckstart: Druckdatei via FTPS laden und parsen
        if (isNewPrint && this.snapshot.printFile) {
          this.fetchPrintFile(this.snapshot.printFile).catch(err =>
            console.error('[bambu] fetchPrintFile:', err),
          );
        }
      } catch {
        // ignore malformed messages
      }
    });

    this.client.on('error', err => {
      this.connected = false;
      this.snapshot = { ...this.snapshot, status: 'offline' };
      console.error('[bambu] MQTT error:', err.message);
      // "connack timeout": Drucker antwortet auf den Verbindungswunsch nicht — am A1/P1
      // typischerweise, weil der einzige lokale Slot (noch) belegt ist.
      const hint = err.message.includes('connack')
        ? ' (Drucker antwortet nicht — lokaler Verbindungs-Slot evtl. noch belegt)' : '';
      addEvent(this.printerId, 'warn', `MQTT-Fehler: ${err.message}${hint}`);
    });

    this.client.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.snapshot = { ...this.snapshot, status: 'offline' };
      if (wasConnected) {
        // Diagnose: Abriss einer STEHENDEN Verbindung getrennt loggen — das ist das
        // Muster "anderer Client hat übernommen" bzw. WLAN-Abriss (≠ connack timeout).
        console.warn('[bambu] Bestehende MQTT-Verbindung abgerissen');
        addEvent(this.printerId, 'warn', 'Bestehende Drucker-Verbindung abgerissen (WLAN-Abriss oder anderes Gerät hat übernommen) — baue neu auf');
      }
      this.scheduleReconnect();
    });
  }

  private async fetchPrintFile(subtaskName?: string): Promise<void> {
    if (!subtaskName) return;
    // Ergebnis nur übernehmen, wenn inzwischen kein neuer Druck begonnen hat.
    const generation = this.printGeneration;
    const setWeights = (weights: FilamentWeight[]) => {
      if (generation === this.printGeneration) this.snapshot = { ...this.snapshot, parsedFilamentWeights: weights };
    };
    // FTPS-Root ist die SD-Karte. Dateien liegen als "{name}.gcode.3mf" (Bambu Studio)
    // HA sucht: /cache/ zuerst, dann Root /
    const name = subtaskName;
    // Bambu Studio bereinigt beim Senden Leerzeichen → Unterstriche und legt die
    // Datei so in /cache/ ab; MQTT meldet aber oft den Originalnamen mit Leerzeichen
    // (z. B. bei SD-Start). Darum beide Schreibweisen als feste Kandidaten probieren,
    // bevor die teure rekursive SD-Suche greift.
    const underscored = name.replace(/ /g, '_');
    const nameVariants = underscored === name ? [name] : [name, underscored];
    const candidates: string[] = nameVariants.flatMap((n) => [
      `/cache/${n}.gcode.3mf`,
      `/cache/${n}.3mf`,
      `/${n}.gcode.3mf`,
      `/${n}.3mf`,
    ]);
    const filename = `${name}.gcode.3mf`;
    console.log(`[bambu] FTPS: Lade Druckdatei "${name}", versuche ${candidates.length} Pfad(e)…`);
    for (const remotePath of candidates) {
      const ftp = new FTPClient();
      ftp.ftp.verbose = false;
      try {
        await ftp.access({
          host: this.ip,
          port: 990,
          user: 'bblp',
          password: this.accessCode,
          secure: 'implicit',
          secureOptions: { rejectUnauthorized: false },
        });
        console.log(`[bambu] FTPS verbunden, lade: ${remotePath}`);
        const writable = new BufferWritable();
        await ftp.downloadTo(writable, remotePath);
        ftp.close();
        const buf = writable.getBuffer();
        const weights: FilamentWeight[] = parseFileBuffer(filename, buf);
        setWeights(weights);
        console.log(`[bambu] Druckdatei geladen: ${filename} → ${weights.length} Filament(e) geparst`);
        addEvent(this.printerId, 'success', `Druckdatei geladen: ${filename} (${weights.length} Slot(s))`);
        return;
      } catch (err: unknown) {
        ftp.close();
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('550')) {
          console.log(`[bambu] FTPS 550 – nicht gefunden: ${remotePath}`);
        } else {
          console.warn(`[bambu] FTPS-Fehler (${remotePath}): ${msg}`);
          addEvent(this.printerId, 'warn', `FTPS-Fehler: ${msg.slice(0, 80)}`);
          return; // Verbindungsfehler → kein weiterer Versuch
        }
      }
    }
    // Fallback: an keinem festen Pfad gefunden → SD-Karte rekursiv durchsuchen.
    // Greift v. a. bei Drucken, die direkt am Drucker von der SD gestartet wurden
    // (MQTT meldet dann den Originalnamen mit Leerzeichen, Datei liegt in einem
    // eigenen Ordner statt in /cache/; gcode_file zeigt auf /data/… = interner
    // Speicher, per FTPS nicht erreichbar → wir müssen die SD selbst absuchen).
    console.log(`[bambu] FTPS: "${name}" an festen Pfaden nicht gefunden – durchsuche SD-Karte rekursiv…`);
    const hit = await this.searchSdForFile(name);
    if (hit) {
      const weights: FilamentWeight[] = parseFileBuffer(hit.path, hit.buf);
      setWeights(weights);
      console.log(`[bambu] Druckdatei via SD-Suche geladen: ${hit.path} → ${weights.length} Filament(e) geparst`);
      addEvent(this.printerId, 'success', `Druckdatei geladen (SD-Suche): ${hit.path.split('/').pop()} (${weights.length} Slot(s))`);
      return;
    }

    console.warn(`[bambu] Druckdatei nicht via FTPS abrufbar: ${filename}`);
    addEvent(this.printerId, 'warn', `Druckdatei nicht via FTPS gefunden: ${filename}`);
  }

  /**
   * Durchsucht die SD-Karte (FTPS-Wurzel) rekursiv nach einer Druckdatei, deren
   * Name zu `name` passt (Leerzeichen/Unterstriche gleichgesetzt) und auf
   * `.gcode.3mf`/`.3mf` endet. Eine einzige FTPS-Verbindung für den ganzen Lauf;
   * Tiefe + Rausch-Ordner begrenzt, damit grosse SD-Karten nicht ausufern.
   */
  private async searchSdForFile(name: string): Promise<{ path: string; buf: Buffer } | null> {
    const ftp = new FTPClient();
    ftp.ftp.verbose = false;
    try {
      await ftp.access({
        host: this.ip,
        port: 990,
        user: 'bblp',
        password: this.accessCode,
        secure: 'implicit',
        secureOptions: { rejectUnauthorized: false },
      });
      const target = normalizeName(name);
      const match = await this.walkSd(ftp, '/', target, 0);
      if (!match) { ftp.close(); return null; }
      const writable = new BufferWritable();
      await ftp.downloadTo(writable, match);
      ftp.close();
      return { path: match, buf: writable.getBuffer() };
    } catch (err: unknown) {
      ftp.close();
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bambu] FTPS-SD-Suche fehlgeschlagen: ${msg}`);
      return null;
    }
  }

  private async walkSd(ftp: FTPClient, dir: string, target: string, depth: number): Promise<string | null> {
    const MAX_DEPTH = 3;
    const SKIP_DIRS = new Set(['timelapse', 'ipcam', 'logger', 'log']);
    let entries: FileInfo[];
    try {
      entries = await ftp.list(dir);
    } catch {
      return null;
    }
    // Erst Dateien im aktuellen Ordner prüfen…
    for (const e of entries) {
      if (!e.isFile) continue;
      const lower = e.name.toLowerCase();
      if (!lower.endsWith('.gcode.3mf') && !lower.endsWith('.3mf')) continue;
      const base = e.name.replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, '');
      if (normalizeName(base) === target) return joinPath(dir, e.name);
    }
    // …dann Unterordner (bis MAX_DEPTH, Rausch-Ordner überspringen).
    if (depth >= MAX_DEPTH) return null;
    for (const e of entries) {
      if (!e.isDirectory || e.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      const found = await this.walkSd(ftp, joinPath(dir, e.name), target, depth + 1);
      if (found) return found;
    }
    return null;
  }

  async getSnapshot(): Promise<PrinterSnapshot> {
    return this.snapshot;
  }

  async sendCommand(cmd: PrinterCommand): Promise<void> {
    if (!this.client || !this.connected) throw new Error('MQTT nicht verbunden');
    const seqId = String(Date.now()).slice(-8);
    let payload: object;
    switch (cmd.type) {
      case 'pause':
        payload = { print: { command: 'pause', sequence_id: seqId } };
        break;
      case 'resume':
        payload = { print: { command: 'resume', sequence_id: seqId } };
        break;
      case 'stop':
        payload = { print: { command: 'stop', sequence_id: seqId } };
        break;
      default:
        throw new Error(`Unbekannter Befehl: ${(cmd as { type?: unknown }).type}`);
    }
    await new Promise<void>((resolve, reject) => {
      this.client!.publish(
        `device/${this.serial}/request`,
        JSON.stringify(payload),
        { qos: 0 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    console.log(`[bambu] Command sent: ${cmd.type}`);
  }
}
