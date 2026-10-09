// Reine (seiteneffektfreie) Job-Logik der Bridge: Übergangs-Erkennung und Filament→Slot-
// Zuordnung. Ausgelagert aus bridge.ts, damit sie ohne Netzwerk/Timer testbar ist.
import type { AmsSlot, FilamentWeight, JobResult, PrinterSnapshot, PrinterStatus } from './adapters/types.js';
import type { SlotRef } from './contract.js';
import type { EventType as LogEventType } from './events.js';

/** Globaler AMS-Index (unit*4+slot) → Anzeige-Label „A1"…„D4"; 254 = externe Spule. */
export function slotLabel(globalIndex: number): string {
  if (globalIndex === 254) return 'Externe Spule';
  return `${String.fromCharCode(65 + Math.floor(globalIndex / 4))}${(globalIndex % 4) + 1}`;
}

export type JobTransition =
  | { kind: 'none' }
  | { kind: 'started' }
  | { kind: 'ended'; outcome: JobResult; eventType: 'job_complete' | 'job_failed' };

const isActive = (s: PrinterStatus | null) => s === 'printing' || s === 'paused';

/**
 * Leitet aus dem letzten bekannten Status und dem neuen Snapshot den Job-Übergang ab.
 *
 * `prevStatus` ist der letzte Status ≠ offline: ein kurzer Verbindungsabriss (offline)
 * ist kein Job-Übergang — sonst ginge das Job-Ende verloren bzw. ein laufender Druck
 * würde nach dem Reconnect als neuer Druck gezählt. `lostContactDuringJob` = es gab
 * während des aktiven Drucks eine offline-Phase; meldet der Adapter dann keinen
 * eindeutigen Ausgang (jobResult null), wird konservativ `aborted` angenommen
 * (kein Materialabzug für einen Druck, dessen Ende niemand gesehen hat).
 */
export function classifyTransition(
  prevStatus: PrinterStatus | null,
  snapshot: Pick<PrinterSnapshot, 'status' | 'jobResult'>,
  lostContactDuringJob = false,
): JobTransition {
  const status = snapshot.status;
  if (status === 'offline') return { kind: 'none' };
  if (isActive(prevStatus) && (status === 'idle' || status === 'error')) {
    const outcome: JobResult = snapshot.jobResult
      ?? (status === 'error' ? 'failed' : lostContactDuringJob ? 'aborted' : 'completed');
    return { kind: 'ended', outcome, eventType: outcome === 'completed' ? 'job_complete' : 'job_failed' };
  }
  if (status === 'printing' && !isActive(prevStatus)) return { kind: 'started' };
  return { kind: 'none' };
}

export interface SlotContext {
  /** Bambu print.mapping (Slicer-Filament-id, 1-basiert → physischer Tray-Code) des laufenden Drucks. */
  filamentMapping: number[];
  /** Zuletzt gemeldeter aktiver physischer Slot (0–15 oder 254), null = unbekannt. */
  activeSlot: number | null;
  /** AMS-Live-Status (Farbe je Slot) für den Mehrfarb-Fallback. */
  amsSlots: AmsSlot[];
}

export interface SlotResolution {
  weights: FilamentWeight[];
  slotSource: SlotRef['source'];
  log: { type: LogEventType; msg: string }[];
}

const normHex = (c?: string) => c ? '#' + c.replace(/^#/, '').replace(/^0x/i, '').slice(0, 6).toUpperCase() : '';

/**
 * Ordnet die geparsten Filamentgewichte physischen Slots zu. Der filamentIndex aus dem
 * Parser ist die SLICER-Filament-id (slice_info), NICHT der physische AMS-Slot. Strategien:
 *  1. PRIMÄR & deterministisch: Bambu ams_mapping (mapping[id-1] → Tray-Code;
 *     unit = code>>8, slot = code&0xFF → global unit*4+slot; -1/≥65535 = externe Spule 254)
 *  2. Fallback Einfarb: aktiver physischer Slot (tray_now)
 *  3. Fallback Mehrfarb: Zuordnung per Farbe gegen den AMS-Live-Status
 * Ohne Treffer bleibt die Slicer-Reihenfolge (`slicer_order`) stehen.
 */
export function resolveFilamentSlots(weights: FilamentWeight[], ctx: SlotContext): SlotResolution {
  const log: SlotResolution['log'] = [];
  if (!weights.length) return { weights, slotSource: 'slicer_order', log };

  // 1. ams_mapping — zählt nur, wenn es MINDESTENS EINE verwertbare Zuordnung liefert.
  // Sonst (z. B. Externe-Spule-Druck: Mapping ohne Eintrag für die Slicer-Filament-id)
  // würde der Slicer-Index ROH als AMS-Index durchgereicht — bei vielen Slicer-
  // Filamenten zeigt der auf einen realen fremden Slot (v0.9.5: id 11 → C4).
  if (ctx.filamentMapping.length) {
    let corrected = 0;
    let valid = 0;
    const remapped = weights.map(fw => {
      const code = ctx.filamentMapping[fw.filamentIndex - 1];
      if (typeof code !== 'number' || !Number.isFinite(code)) return fw;
      if (code < 0 || code >= 65535) { valid++; return { ...fw, filamentIndex: 254 }; }
      const amsUnit = (code >> 8) & 0xFF;
      const slot = code & 0xFF;
      if (amsUnit > 3 || slot > 3) return fw; // unerwartete Kodierung → roh lassen
      valid++;
      const gi = amsUnit * 4 + slot;
      if (gi !== fw.filamentIndex) corrected++;
      return { ...fw, filamentIndex: gi };
    });
    if (valid > 0) {
      log.push({ type: 'info', msg: `Filament-Zuordnung via Bambu ams_mapping (${remapped.length} Filament(e), ${corrected} korrigiert)` });
      return { weights: remapped, slotSource: 'ams', log };
    }
    log.push({ type: 'info', msg: 'ams_mapping ohne verwertbare Zuordnung — Fallback: aktiver Slot' });
  }

  // 2. Einfarb: Verbrauch dem aktiven physischen Slot zuordnen.
  if (weights.length === 1) {
    const fw = weights[0];
    if (ctx.activeSlot == null) {
      log.push({ type: 'warn', msg: 'Aktiver AMS-Slot unbekannt — Filament evtl. nicht verknüpft' });
      return { weights, slotSource: 'slicer_order', log };
    }
    log.push({ type: 'info', msg: `Filamentverbrauch → AMS-Slot ${slotLabel(ctx.activeSlot)} (${fw.grams} g)` });
    return { weights: [{ ...fw, filamentIndex: ctx.activeSlot }], slotSource: 'ams', log };
  }

  // 3. Mehrfarb: eindeutige Farbtreffer gegen den AMS-Status.
  if (!ctx.amsSlots.length) {
    log.push({ type: 'warn', msg: 'Mehrfarb-Druck: kein ams_mapping/AMS-Status — Filamente evtl. nach Slicer-Reihenfolge zugeordnet' });
    return { weights, slotSource: 'slicer_order', log };
  }
  let remappedCount = 0;
  const remapped = weights.map(fw => {
    if (!fw.color) return fw;
    const want = normHex(fw.color);
    const matches = ctx.amsSlots.filter(s => normHex(s.color) === want);
    if (matches.length !== 1) return fw;
    const gi = matches[0].ams_unit * 4 + matches[0].slot;
    if (gi === fw.filamentIndex) return fw;
    remappedCount++;
    return { ...fw, filamentIndex: gi };
  });
  if (remappedCount === 0) return { weights, slotSource: 'slicer_order', log };
  log.push({ type: 'info', msg: `Mehrfarb-Druck: ${remappedCount} Filament(e) per Farbe dem AMS-Slot zugeordnet (Fallback)` });
  return { weights: remapped, slotSource: 'ams', log };
}
