import { describe, expect, it } from 'vitest';
import * as moonraker from '../src/adapters/moonraker.js';
import * as prusa from '../src/adapters/prusa.js';

describe('Moonraker state mapping', () => {
  it('maps print_stats.state to printer status', () => {
    expect(moonraker.mapState('printing')).toBe('printing');
    expect(moonraker.mapState('paused')).toBe('paused');
    expect(moonraker.mapState('error')).toBe('error');
    for (const s of ['standby', 'complete', 'cancelled', '']) expect(moonraker.mapState(s)).toBe('idle');
  });

  it('distinguishes complete from cancelled', () => {
    expect(moonraker.mapJobResult('complete')).toBe('completed');
    expect(moonraker.mapJobResult('cancelled')).toBe('aborted');
    expect(moonraker.mapJobResult('error')).toBe('failed');
    expect(moonraker.mapJobResult('printing')).toBeNull();
  });
});

describe('Prusa Link state mapping', () => {
  it('maps printer.state to printer status', () => {
    expect(prusa.mapState('PRINTING', true)).toBe('printing');
    expect(prusa.mapState('PAUSED', true)).toBe('paused');
    expect(prusa.mapState('ERROR', false)).toBe('error');
    for (const s of ['IDLE', 'BUSY', 'READY', 'FINISHED', 'STOPPED']) expect(prusa.mapState(s, false)).toBe('idle');
  });

  it('treats ATTENTION as paused during a job and as error otherwise', () => {
    expect(prusa.mapState('ATTENTION', true)).toBe('paused');
    expect(prusa.mapState('ATTENTION', false)).toBe('error');
  });

  it('distinguishes FINISHED from STOPPED', () => {
    expect(prusa.mapJobResult('FINISHED')).toBe('completed');
    expect(prusa.mapJobResult('STOPPED')).toBe('aborted');
    expect(prusa.mapJobResult('ERROR')).toBe('failed');
    expect(prusa.mapJobResult('PRINTING')).toBeNull();
  });
});
