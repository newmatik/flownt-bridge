import fetch from 'node-fetch';
import { PrinterConfig, FLOWNT_EDGE_URL } from './config.js';
import type { PrinterBridgeState } from './server.js';
import { Adapter, PrinterSnapshot, AmsSlot } from './adapters/types.js';
import { EventType, IngestBody, SlotRef } from './contract.js';
import { BRIDGE_VERSION } from './version.js';
import { BambuCloudClient } from './bambu-cloud.js';
import { ShellyClient } from './smartplug/shelly.js';
import { addEvent } from './events.js';
import { classifyTransition, resolveFilamentSlots, slotLabel } from './job-events.js';

async function push(
  cfg: PrinterConfig,
  snapshot: PrinterSnapshot,
  eventType: EventType = 'status_update',
  durationMin?: number,
  slotSource: SlotRef['source'] = 'slicer_order',
): Promise<string | undefined> {
  const body: IngestBody = {
    auth_token: cfg.flowntAuthToken,
    event_type: eventType,
    bridge_version: BRIDGE_VERSION,
    printer_status: snapshot.status,
    print_file: snapshot.printFile,
    progress_pct: snapshot.progressPct,
    temp_hotend: snapshot.tempHotend,
    temp_bed: snapshot.tempBed,
    eta_s: snapshot.etaSec,
  };
  if (durationMin != null) body.duration_min = durationMin;
  if (eventType === 'job_complete' && snapshot.sourceJobId) body.source_job_id = snapshot.sourceJobId;
  if (snapshot.powerW != null) body.live_power_w = snapshot.powerW;
  if (snapshot.amsSlots?.length) body.ams_state = snapshot.amsSlots;
  if (snapshot.activeMqttSlot != null) body.ams_active_slot = snapshot.activeMqttSlot;
  if (snapshot.amsHumidity?.length) body.ams_humidity = snapshot.amsHumidity;
  if (eventType === 'job_complete') {
    if (snapshot.parsedFilamentWeights?.length) {
      // Stufe B: pro Materialzeile die quell-abstrahierte Slot-Referenz mitführen.
      // `filamentIndex` bleibt unverändert als Kompat-Feld (Backend liest weiterhin dieses Feld).
      body.filament_weights = snapshot.parsedFilamentWeights.map(fw => ({
        filamentIndex: fw.filamentIndex,
        grams: fw.grams,
        color: fw.color,
        slotRef: { source: slotSource, value: fw.filamentIndex },
        measureSource: 'slicer_file' as const,
      }));
    }
    if (snapshot.cloudWeightG != null) body.cloud_weight_g = snapshot.cloudWeightG;
    if (snapshot.energyWhUsed != null) body.energy_wh = snapshot.energyWhUsed;
  }

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${FLOWNT_EDGE_URL}/bridge-ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new PushError(String(err), mayHaveReachedServer(err));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Der Server hat mit einem Fehler geantwortet → nichts verbucht, Wiederholung ist sicher.
    throw new PushError(`bridge-ingest ${res.status}: ${text}`, false);
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return typeof data.print_log_id === 'string' ? data.print_log_id : undefined;
}

/** Push-Fehler mit der Info, ob der Request den Server evtl. doch erreicht hat. */
export class PushError extends Error {
  constructor(message: string, readonly maybeDelivered: boolean) {
    super(message);
  }
}

// Verbindungsaufbau gescheitert (DNS, refused, offline) → Request kam sicher nicht an.
// Timeout oder Abbruch mitten in der Antwort → Server hat evtl. schon verbucht.
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
export function mayHaveReachedServer(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  const code = e?.code ?? e?.cause?.code;
  return !(code && NOT_SENT_CODES.has(code));
}

/**
 * Darf ein fehlgeschlagenes Job-Ende wiederholt werden? Nur wenn es sicher nicht
 * angekommen ist oder das Backend die Wiederholung über source_job_id dedupen kann —
 * sonst droht ein doppelter Drucklog mit doppeltem Materialabzug.
 */
export function canRetryJobEvent(err: unknown, eventType: EventType, sourceJobId?: string | null): boolean {
  if (err instanceof PushError && !err.maybeDelivered) return true;
  return eventType === 'job_complete' && !!sourceJobId;
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms));
}

interface PendingJobEvent {
  snapshot: PrinterSnapshot;
  eventType: EventType;
  durationMin?: number;
  slotSource: SlotRef['source'];
  attempts: number;
  firstFailedAt: number;
  nextAttemptAt: number;
}

const JOB_EVENT_RETRY_MAX_AGE_MS = 6 * 60 * 60_000; // nach 6 h aufgeben
const JOB_EVENT_RETRY_MAX_DELAY_MS = 5 * 60_000;
const MAX_PENDING_JOB_EVENTS = 20;

export async function runBridge(
  adapter: Adapter,
  cfg: PrinterConfig,
  state: PrinterBridgeState,
  isCancelled: () => boolean,
): Promise<void> {
  console.log(`[${cfg.name}] Verbindung wird aufgebaut…`);

  const bambuCloud = (cfg.bambuCloudEmail && cfg.bambuCloudPassword)
    ? new BambuCloudClient(cfg.bambuCloudEmail, cfg.bambuCloudPassword)
    : null;

  const smartPlug = (cfg.smartPlugType === 'shelly' && cfg.smartPlugUrl)
    ? new ShellyClient(cfg.smartPlugUrl)
    : null;
  if (smartPlug) addEvent(cfg.id, 'info', `Smart-Plug aktiv: ${cfg.smartPlugUrl}`);

  // Initial heartbeat to verify token
  try {
    const heartbeat: IngestBody = { auth_token: cfg.flowntAuthToken, event_type: 'heartbeat', bridge_version: BRIDGE_VERSION };
    const res = await fetch(`${FLOWNT_EDGE_URL}/bridge-ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeat),
      signal: AbortSignal.timeout(10_000),
    });
    // Ohne Status-Check meldete ein abgelehnter Token (401) trotzdem „Auth OK".
    if (!res.ok) throw new Error(`bridge-ingest ${res.status}`);
    console.log(`[${cfg.name}] Auth OK ✓`);
    state.error = null;
    addEvent(cfg.id, 'success', 'Verbindung zu Flownt hergestellt ✓');
  } catch (e) {
    console.error(`[${cfg.name}] Heartbeat fehlgeschlagen:`, e);
    state.error = 'Keine Verbindung zu Flownt. Bitte Token und Server-URL prüfen.';
    addEvent(cfg.id, 'warn', 'Heartbeat fehlgeschlagen — Token oder Verbindung prüfen');
  }

  let consecutiveErrors = 0;
  let prevStatus: PrinterSnapshot['status'] | null = null; // letzter Status ≠ offline
  let lostContactDuringJob = false;           // offline-Phase während eines aktiven Drucks
  let printStartedAt: number | null = null;
  let lastActiveSlot: number | null = null;   // physischer AMS-Slot (tray_now), global: unit*4+slot
  let lastSourceJobId: string | null = null;  // Job-ID während des Drucks gemerkt → beim Abschluss senden (Dedup)
  let lastAmsSlots: AmsSlot[] = [];           // letzter AMS-Status (Farbe je physischem Slot) — Fallback-Zuordnung per Farbe
  let lastFilamentMapping: number[] = [];     // Bambu print.mapping (Slicer-Filament-id → physischer Tray-Code) — primäre, deterministische Zuordnung
  let lastEnergyWh: number | null = null;     // letzter Energiezähler-Stand vom Smart-Plug (Wh)
  let energyStartWh: number | null = null;    // Zählerstand bei Druckstart (für Verbrauchs-Differenz)
  // Job-Enden, deren Push fehlgeschlagen ist: werden neben dem normalen Polling erneut
  // gesendet, sonst ginge der Drucklog bei einem Netzwerkfehler am Druckende verloren
  // (der Übergang ist danach schon „verbraucht"). Siehe canRetryJobEvent.
  const pendingJobEvents: PendingJobEvent[] = [];
  const schedule = (p: PendingJobEvent) => {
    p.nextAttemptAt = Date.now() + Math.min(p.attempts * 30_000, JOB_EVENT_RETRY_MAX_DELAY_MS);
  };

  while (!isCancelled()) {
    try {
      // Ausstehende Job-Enden nachmelden — blockiert das Polling nicht, damit ein
      // weiterer Druck während eines längeren Ausfalls trotzdem erkannt wird.
      for (const p of [...pendingJobEvents]) {
        if (Date.now() < p.nextAttemptAt) continue;
        p.attempts++;
        const file = p.snapshot.printFile ?? '–';
        try {
          await push(cfg, p.snapshot, p.eventType, p.durationMin, p.slotSource);
          pendingJobEvents.splice(pendingJobEvents.indexOf(p), 1);
          addEvent(cfg.id, 'success', `Job-Ende nachgemeldet: ${file}`);
        } catch (err) {
          if (!canRetryJobEvent(err, p.eventType, p.snapshot.sourceJobId)
              || Date.now() - p.firstFailedAt > JOB_EVENT_RETRY_MAX_AGE_MS) {
            pendingJobEvents.splice(pendingJobEvents.indexOf(p), 1);
            addEvent(cfg.id, 'warn', `Job-Ende evtl. nicht in Flownt angekommen — bitte Drucklog prüfen: ${file}`);
          } else {
            schedule(p);
          }
          console.error(`[${cfg.name}] Nachmelden fehlgeschlagen (${p.attempts}×):`, err);
        }
      }

      let snapshot = await adapter.getSnapshot();
      // Während getSnapshot() gestoppt (Config geändert/gelöscht) → nicht mehr pushen.
      if (isCancelled()) break;

      // Smart-Plug (Shelly): Momentanleistung lesen und in den Snapshot mergen.
      // Fehlertolerant — ein nicht erreichbarer Plug darf den Druckerstatus nicht stören.
      if (smartPlug) {
        const reading = await smartPlug.read();
        if (reading) {
          snapshot = { ...snapshot, powerW: Math.round(reading.powerW) };
          lastEnergyWh = reading.energyWh;
        }
      }

      state.snapshot = snapshot;

      // Job-Übergang erkennen: aktiv (printing/paused) → terminal (idle ODER error).
      // Ausgang aus dem normalisierten jobResult des Adapters; Fallback aus dem Status.
      let eventType: EventType = 'status_update';
      let durationMin: number | undefined;
      const transition = classifyTransition(prevStatus, snapshot, lostContactDuringJob);
      if (transition.kind === 'ended') {
        const { outcome } = transition;
        eventType = transition.eventType;
        // Job-ID vom laufenden Druck an den Abschluss hängen (Re-Emission → gleiche ID → Dedup)
        snapshot = { ...snapshot, sourceJobId: lastSourceJobId ?? snapshot.sourceJobId };
        if (printStartedAt != null) {
          durationMin = Math.round((Date.now() - printStartedAt) / 60_000);
        }
        printStartedAt = null;
        lastSourceJobId = null;
        lostContactDuringJob = false;
        // Gemessener Stromverbrauch = Energiezähler(Ende) − Energiezähler(Start) — auch bei Abbruch sinnvoll
        if (smartPlug && energyStartWh != null && lastEnergyWh != null) {
          const usedWh = lastEnergyWh - energyStartWh;
          if (usedWh >= 0 && usedWh < 100_000) { // Guard gegen Zählerreset / Ausreißer
            snapshot = { ...snapshot, energyWhUsed: usedWh };
            addEvent(cfg.id, 'info', `Stromverbrauch: ${(usedWh / 1000).toFixed(3)} kWh`);
          }
        }
        energyStartWh = null;
        if (eventType === 'job_failed') {
          addEvent(cfg.id, 'warn', `Druck ${outcome === 'aborted' ? 'abgebrochen' : 'fehlgeschlagen'} — kein Materialabzug`);
          console.log(`[${cfg.name}] Job ${outcome} → Abbruch-Log (${durationMin ?? '?'} min, kein Abzug)`);
        } else {
          console.log(`[${cfg.name}] Job abgeschlossen → Drucklog-Eintrag (${durationMin ?? '?'} min)`);
        }
      } else if (transition.kind === 'started') {
        printStartedAt = Date.now();
        energyStartWh = lastEnergyWh; // Energiezähler-Stand bei Druckstart merken
        // JOB-Zustand des Vordrucks verwerfen: ams_mapping und Job-ID gehören zum jeweiligen
        // Druck. Ohne Reset erbte ein Druck ohne eigenes Mapping (externe Spule!) das Mapping
        // des Vordrucks (v0.9.4) bzw. ein Druck ohne Job-ID die ID des Vordrucks — und würde
        // im Backend als Duplikat verworfen. lastActiveSlot bleibt bewusst stehen (254 kommt
        // schon in der Vorbereitung, vor diesem Übergang).
        lastFilamentMapping = [];
        lastSourceJobId = null;
        lostContactDuringJob = false;
        addEvent(cfg.id, 'info', `Druck gestartet: ${snapshot.printFile ?? '–'}`);
      }

      // Job-ID während des Drucks merken → beim Abschluss senden (Dedup gegen Re-Emission)
      if (snapshot.status === 'printing' && snapshot.sourceJobId) lastSourceJobId = snapshot.sourceJobId;

      if (snapshot.status === 'offline') {
        if (prevStatus === 'printing' || prevStatus === 'paused') lostContactDuringJob = true;
      } else {
        prevStatus = snapshot.status;
      }

      // Aktiven physischen Slot merken, SOBALD der Drucker ihn meldet (0–15 = AMS-Slot,
      // 254 = externe Spule; 255 = kein Tray → ignorieren, letzter bekannter zählt).
      // BEWUSST ohne printing-Gate: Bambu sendet Teil-Updates — der Tray-Wechsel auf 254
      // kommt oft schon in der Druckvorbereitung (Laden/Aufheizen) und wird während des
      // Drucks nicht wiederholt. Mit Gate blieb dann der Slot des VORHERIGEN Drucks
      // stehen und der Externe-Spule-Verbrauch landete auf der falschen AMS-Spule.
      if (typeof snapshot.activeMqttSlot === 'number'
          && ((snapshot.activeMqttSlot >= 0 && snapshot.activeMqttSlot < 16) || snapshot.activeMqttSlot === 254)
          && lastActiveSlot !== snapshot.activeMqttSlot) {
        lastActiveSlot = snapshot.activeMqttSlot;
        // Sichtbare Diagnose im Ereignis-Log: welcher Slot würde aktuell gebucht?
        addEvent(cfg.id, 'info', `Aktiver Filament-Slot: ${slotLabel(lastActiveSlot)}`);
      }
      // AMS-Status + ams_mapping während des Drucks merken (kommen nicht in jeder MQTT-Nachricht).
      if (snapshot.status === 'printing' && snapshot.amsSlots?.length) {
        lastAmsSlots = snapshot.amsSlots;
      }
      if (snapshot.status === 'printing' && snapshot.filamentMapping?.length) {
        lastFilamentMapping = snapshot.filamentMapping;
      }

      // Filament → physischer Slot (Strategien siehe resolveFilamentSlots). Quelle der
      // Slot-Identität (Stufe B): 'ams' in den Bambu-AMS-Pfaden, sonst Slicer-Reihenfolge.
      let slotSource: SlotRef['source'] = 'slicer_order';
      if (eventType === 'job_complete' && snapshot.parsedFilamentWeights?.length) {
        const resolved = resolveFilamentSlots(snapshot.parsedFilamentWeights, {
          filamentMapping: lastFilamentMapping,
          activeSlot: lastActiveSlot,
          amsSlots: snapshot.amsSlots?.length ? snapshot.amsSlots : lastAmsSlots,
        });
        snapshot = { ...snapshot, parsedFilamentWeights: resolved.weights };
        slotSource = resolved.slotSource;
        for (const e of resolved.log) addEvent(cfg.id, e.type, e.msg);
      }

      // Cloud-Gewicht via Bambu API NUR holen, wenn FTPS nichts geliefert hat.
      // Bambus Login verschickt sonst bei jedem Druckende einen Verification-Code per Mail.
      const ftpsGotWeights = (snapshot.parsedFilamentWeights?.length ?? 0) > 0;
      if (eventType === 'job_complete' && bambuCloud && cfg.adapterSerial && !ftpsGotWeights) {
        const cloudWeight = await bambuCloud.getLatestTaskWeightWithRetry(cfg.adapterSerial);
        if (cloudWeight != null) snapshot = { ...snapshot, cloudWeightG: cloudWeight };
      }

      // Backend only accepts: idle, printing, maintenance, offline, error
      // Map "paused" → "printing" (job is still active)
      const pushSnapshot: PrinterSnapshot = snapshot.status === 'paused'
        ? { ...snapshot, status: 'printing' }
        : snapshot;

      let printLogId: string | undefined;
      try {
        printLogId = await push(cfg, pushSnapshot, eventType, durationMin, slotSource);
      } catch (err) {
        if (eventType !== 'status_update') {
          const file = pushSnapshot.printFile ?? '–';
          if (canRetryJobEvent(err, eventType, pushSnapshot.sourceJobId)) {
            const now = Date.now();
            const p: PendingJobEvent = { snapshot: pushSnapshot, eventType, durationMin, slotSource, attempts: 1, firstFailedAt: now, nextAttemptAt: now };
            schedule(p);
            pendingJobEvents.push(p);
            if (pendingJobEvents.length > MAX_PENDING_JOB_EVENTS) pendingJobEvents.shift();
            addEvent(cfg.id, 'warn', `Job-Ende konnte nicht gesendet werden — wird wiederholt: ${file}`);
          } else {
            addEvent(cfg.id, 'warn', `Job-Ende evtl. nicht in Flownt angekommen — bitte Drucklog prüfen: ${file}`);
          }
        }
        throw err;
      }
      state.lastPushAt = new Date();
      state.error = null;
      consecutiveErrors = 0;
      if (eventType === 'job_complete') {
        const idHint = printLogId ? ` (${printLogId.slice(0, 8)}…)` : '';
        addEvent(cfg.id, 'success', `Drucklog erstellt${idHint}: ${snapshot.printFile ?? '–'}`);
      }

      const progress = snapshot.progressPct != null ? ` ${snapshot.progressPct}%` : '';
      const file = snapshot.printFile ? ` "${snapshot.printFile}"` : '';
      console.log(`[${cfg.name}] ${new Date().toISOString()} → ${snapshot.status.toUpperCase()}${file}${progress}`);
    } catch (err) {
      consecutiveErrors++;
      const backoff = Math.min(consecutiveErrors * 5_000, 60_000);
      state.error = `Verbindungsfehler (${consecutiveErrors}×). Nächster Versuch in ${backoff / 1000}s.`;
      console.error(`[${cfg.name}] Fehler (${consecutiveErrors}×):`, err);
      if (consecutiveErrors === 1) addEvent(cfg.id, 'warn', `Verbindungsfehler: ${String(err).slice(0, 80)}`);
      await sleep(backoff);
      continue;
    }

    await sleep(cfg.pollingIntervalMs);
  }
}
