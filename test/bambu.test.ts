import { describe, expect, it } from 'vitest';
import {
  applyReport, mapJobResult, mapState, normalizeColor, parseAmsHumidity, parseAmsSlots,
  type BambuPrint,
} from '../src/adapters/bambu.js';
import type { PrinterSnapshot } from '../src/adapters/types.js';

describe('Bambu state mapping', () => {
  it('maps gcode_state to printer status (case-insensitive)', () => {
    expect(mapState('RUNNING')).toBe('printing');
    expect(mapState('pause')).toBe('paused');
    expect(mapState('FAILED')).toBe('error');
    for (const s of ['IDLE', 'FINISH', 'CREATED', 'PREPARE', 'whatever']) expect(mapState(s)).toBe('idle');
  });

  it('maps terminal gcode_state to a job result', () => {
    expect(mapJobResult('FINISH')).toBe('completed');
    expect(mapJobResult('FAILED')).toBe('failed');
    expect(mapJobResult('RUNNING')).toBeNull();
    expect(mapJobResult('IDLE')).toBeNull();
  });
});

describe('Bambu AMS parsing', () => {
  it('normalizes colours from 0xRRGGBBAA / #RRGGBB and defaults to grey', () => {
    expect(normalizeColor('0xffaa00ff')).toBe('#FFAA00');
    expect(normalizeColor('#00ff00')).toBe('#00FF00');
    expect(normalizeColor('FF000080')).toBe('#FF0000');
    expect(normalizeColor(undefined)).toBe('#888888');
  });

  it('flattens units and trays into global slots with defaults', () => {
    const slots = parseAmsSlots({ ams: [
      { tray: [{ tray_type: 'PLA', tray_color: '0xFF0000FF', remain: 80, tray_weight: 1000 }, {}] },
      { tray: [{ tray_type: 'PETG', tray_color: '00FF00FF' }] },
    ] });
    expect(slots).toEqual([
      { ams_unit: 0, slot: 0, material: 'PLA', color: '#FF0000', remain: 80, tray_weight: 1000 },
      { ams_unit: 0, slot: 1, material: '', color: '#888888', remain: 0, tray_weight: 1000 },
      { ams_unit: 1, slot: 0, material: 'PETG', color: '#00FF00', remain: 0, tray_weight: 1000 },
    ]);
    expect(parseAmsSlots(undefined)).toEqual([]);
  });

  it('parses humidity level, optional real % and temperature; drops units without a level', () => {
    expect(parseAmsHumidity({ ams: [
      { humidity: '4', humidity_raw: '24', temp: '28.7' },
      { humidity: '2', humidity_raw: 'n/a', temp: '25' },
      { humidity: '0' },
    ] })).toEqual([
      { ams_unit: 0, humidity: 4, humidity_pct: 24, temp: 28.7 },
      { ams_unit: 1, humidity: 2, humidity_pct: undefined, temp: 25 },
    ]);
  });
});

describe('applyReport (MQTT merge)', () => {
  const printing: PrinterSnapshot = {
    status: 'printing', printFile: 'Benchy', sourceJobId: '123', progressPct: 40,
    activeMqttSlot: 254, filamentMapping: [0x0001], parsedFilamentWeights: [{ filamentIndex: 1, grams: 5 }],
  };

  it('keeps the last reported status and fields when a delta omits them', () => {
    const { snapshot, isNewPrint } = applyReport(printing, 'printing', { command: 'push_status', mc_percent: 41 });
    expect(snapshot.status).toBe('printing');
    expect(snapshot).toMatchObject({ printFile: 'Benchy', sourceJobId: '123', progressPct: 41, activeMqttSlot: 254 });
    expect(snapshot.filamentMapping).toEqual([0x0001]);
    expect(snapshot.parsedFilamentWeights).toEqual([{ filamentIndex: 1, grams: 5 }]);
    expect(isNewPrint).toBe(false);
  });

  it('treats an empty gcode_state as IDLE', () => {
    expect(applyReport(printing, 'printing', { command: 'push_status', gcode_state: '' }).status).toBe('idle');
  });

  it('reports FINISH as idle with jobResult completed', () => {
    const { snapshot } = applyReport(printing, 'printing', { gcode_state: 'FINISH' });
    expect(snapshot).toMatchObject({ status: 'idle', jobResult: 'completed' });
  });

  it('restores the status after an offline phase without counting a new print', () => {
    const offline = { ...printing, status: 'offline' as const };
    const r = applyReport(offline, 'printing', { gcode_state: 'RUNNING' });
    expect(r.status).toBe('printing');
    expect(r.isNewPrint).toBe(false);
    expect(r.snapshot.parsedFilamentWeights).toHaveLength(1);
  });

  it('v0.9.4: a new print drops the previous job mapping, weights and job id', () => {
    const idle = { ...printing, status: 'idle' as const };
    const p: BambuPrint = { gcode_state: 'RUNNING', subtask_name: 'Spool test', subtask_id: '0' };
    const { snapshot, isNewPrint } = applyReport(idle, 'idle', p);
    expect(isNewPrint).toBe(true);
    expect(snapshot.filamentMapping).toBeUndefined();
    expect(snapshot.parsedFilamentWeights).toBeNull();
    expect(snapshot.sourceJobId).toBeUndefined(); // "0" = no job id (local/SD print)
    expect(snapshot.activeMqttSlot).toBe(254);    // active slot stays sticky
  });

  it('accepts tray_now as string and ignores garbage', () => {
    expect(applyReport(printing, 'printing', { ams: { tray_now: '5' } }).snapshot.activeMqttSlot).toBe(5);
    expect(applyReport(printing, 'printing', { ams: { tray_now: 'x' } }).snapshot.activeMqttSlot).toBe(254);
  });

  it('takes a new ams mapping from the message', () => {
    expect(applyReport(printing, 'printing', { mapping: [0x0102, 65535] }).snapshot.filamentMapping).toEqual([0x0102, 65535]);
  });

  it('falls back from subtask_id to job_id', () => {
    expect(applyReport({ status: 'idle' }, 'idle', { gcode_state: 'RUNNING', subtask_id: '', job_id: '987' }).snapshot.sourceJobId).toBe('987');
  });
});
