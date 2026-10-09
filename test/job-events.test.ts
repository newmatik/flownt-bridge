import { describe, expect, it } from 'vitest';
import { classifyTransition, resolveFilamentSlots, slotLabel } from '../src/job-events.js';
import type { AmsSlot } from '../src/adapters/types.js';

describe('slotLabel', () => {
  it('maps global AMS indices to A1…D4 and 254 to the external spool', () => {
    expect(slotLabel(0)).toBe('A1');
    expect(slotLabel(5)).toBe('B2');
    expect(slotLabel(15)).toBe('D4');
    expect(slotLabel(254)).toBe('Externe Spule');
  });
});

describe('classifyTransition', () => {
  it('detects a print start from idle, null (bridge start) and error', () => {
    for (const prev of ['idle', null, 'error'] as const) {
      expect(classifyTransition(prev, { status: 'printing' })).toEqual({ kind: 'started' });
    }
  });

  it('treats a job first seen as paused as a new print', () => {
    for (const prev of ['idle', null, 'error'] as const) {
      expect(classifyTransition(prev, { status: 'paused' })).toEqual({ kind: 'started' });
    }
  });

  it('does not restart on printing → printing or paused → printing', () => {
    expect(classifyTransition('printing', { status: 'printing' })).toEqual({ kind: 'none' });
    expect(classifyTransition('paused', { status: 'printing' })).toEqual({ kind: 'none' });
  });

  it('uses the adapter jobResult at the terminal transition', () => {
    expect(classifyTransition('printing', { status: 'idle', jobResult: 'completed' }))
      .toEqual({ kind: 'ended', outcome: 'completed', eventType: 'job_complete' });
    expect(classifyTransition('paused', { status: 'idle', jobResult: 'aborted' }))
      .toEqual({ kind: 'ended', outcome: 'aborted', eventType: 'job_failed' });
    expect(classifyTransition('printing', { status: 'error', jobResult: 'failed' }))
      .toEqual({ kind: 'ended', outcome: 'failed', eventType: 'job_failed' });
  });

  it('falls back to the status when the adapter reports no jobResult', () => {
    expect(classifyTransition('printing', { status: 'idle', jobResult: null }))
      .toMatchObject({ outcome: 'completed', eventType: 'job_complete' });
    expect(classifyTransition('printing', { status: 'error' }))
      .toMatchObject({ outcome: 'failed', eventType: 'job_failed' });
  });

  it('treats an unknown outcome after lost contact as aborted (no material booking)', () => {
    expect(classifyTransition('printing', { status: 'idle', jobResult: null }, true))
      .toMatchObject({ outcome: 'aborted', eventType: 'job_failed' });
    // …but an explicit FINISH/complete still wins
    expect(classifyTransition('printing', { status: 'idle', jobResult: 'completed' }, true))
      .toMatchObject({ outcome: 'completed', eventType: 'job_complete' });
  });

  it('never treats offline as a transition', () => {
    expect(classifyTransition('printing', { status: 'offline' })).toEqual({ kind: 'none' });
    expect(classifyTransition('idle', { status: 'offline' })).toEqual({ kind: 'none' });
  });

  it('ignores idle ↔ error without an active job', () => {
    expect(classifyTransition('idle', { status: 'error' })).toEqual({ kind: 'none' });
    expect(classifyTransition('error', { status: 'idle' })).toEqual({ kind: 'none' });
  });
});

const slot = (ams_unit: number, s: number, color: string): AmsSlot =>
  ({ ams_unit, slot: s, color, material: 'PLA', remain: 50, tray_weight: 1000 });

describe('resolveFilamentSlots — ams_mapping', () => {
  it('decodes tray codes (unit = code>>8, slot = code&0xFF) per 1-based slicer id', () => {
    const r = resolveFilamentSlots(
      [{ filamentIndex: 1, grams: 5 }, { filamentIndex: 2, grams: 7 }],
      { filamentMapping: [0x0102, 3], activeSlot: 0, amsSlots: [] },
    );
    expect(r.weights.map(w => w.filamentIndex)).toEqual([6, 3]); // B3, A4
    expect(r.slotSource).toBe('ams');
  });

  it('maps -1 and ≥65535 to the external spool (254)', () => {
    const r = resolveFilamentSlots(
      [{ filamentIndex: 1, grams: 5 }, { filamentIndex: 2, grams: 7 }],
      { filamentMapping: [-1, 65535], activeSlot: null, amsSlots: [] },
    );
    expect(r.weights.map(w => w.filamentIndex)).toEqual([254, 254]);
    expect(r.slotSource).toBe('ams');
  });

  it('leaves unexpected encodings raw but keeps valid entries', () => {
    const r = resolveFilamentSlots(
      [{ filamentIndex: 1, grams: 5 }, { filamentIndex: 2, grams: 7 }],
      { filamentMapping: [0x0500, 0x0001], activeSlot: null, amsSlots: [] },
    );
    expect(r.weights.map(w => w.filamentIndex)).toEqual([1, 1]);
  });

  it('v0.9.5: mapping without a usable entry falls back to the active slot instead of the raw slicer id', () => {
    // Slicer-Filament id 11 on an external-spool print; mapping only covers ids 1–2.
    const r = resolveFilamentSlots(
      [{ filamentIndex: 11, grams: 12 }],
      { filamentMapping: [0, 1], activeSlot: 254, amsSlots: [] },
    );
    expect(r.weights).toEqual([{ filamentIndex: 254, grams: 12 }]);
    expect(r.slotSource).toBe('ams');
    expect(r.log.map(l => l.msg)).toContain('ams_mapping ohne verwertbare Zuordnung — Fallback: aktiver Slot');
  });
});

describe('resolveFilamentSlots — fallbacks', () => {
  it('v0.9.1/v0.9.4: single filament without mapping goes to the active slot (external spool)', () => {
    const r = resolveFilamentSlots([{ filamentIndex: 1, grams: 3 }], { filamentMapping: [], activeSlot: 254, amsSlots: [] });
    expect(r.weights).toEqual([{ filamentIndex: 254, grams: 3 }]);
    expect(r.slotSource).toBe('ams');
  });

  it('single filament with unknown active slot stays in slicer order and warns', () => {
    const r = resolveFilamentSlots([{ filamentIndex: 1, grams: 3 }], { filamentMapping: [], activeSlot: null, amsSlots: [] });
    expect(r.weights).toEqual([{ filamentIndex: 1, grams: 3 }]);
    expect(r.slotSource).toBe('slicer_order');
    expect(r.log[0].type).toBe('warn');
  });

  it('multi-colour: maps unique colour matches, leaves ambiguous ones alone', () => {
    const r = resolveFilamentSlots(
      [
        { filamentIndex: 1, grams: 2, color: '#ff0000' },
        { filamentIndex: 2, grams: 4, color: '#00FF00FF' },
        { filamentIndex: 3, grams: 6, color: '#0000FF' },
      ],
      {
        filamentMapping: [],
        activeSlot: 0,
        amsSlots: [slot(0, 0, '#0000FF'), slot(0, 3, '#FF0000'), slot(1, 1, '#00FF00'), slot(1, 2, '#0000FF')],
      },
    );
    expect(r.weights.map(w => w.filamentIndex)).toEqual([3, 5, 3]);
    expect(r.slotSource).toBe('ams');
  });

  it('multi-colour without AMS status keeps slicer order', () => {
    const w = [{ filamentIndex: 1, grams: 2, color: '#FF0000' }, { filamentIndex: 2, grams: 4 }];
    const r = resolveFilamentSlots(w, { filamentMapping: [], activeSlot: 0, amsSlots: [] });
    expect(r.weights).toBe(w);
    expect(r.slotSource).toBe('slicer_order');
  });
});
