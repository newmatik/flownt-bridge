import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'flownt-bridge-test-'));
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => home }));

const { loadMultiConfig, saveMultiConfig, normalizeConfig } = await import('../src/config.js');
const dir = join(home, '.flownt-bridge');
const file = join(dir, 'config.json');

afterAll(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => rmSync(dir, { recursive: true, force: true }));

const printer = {
  id: 'p1', name: 'X1C', flowntAuthToken: 't', adapterType: 'bambu', adapterUrl: '192.168.1.2',
  adapterApiKey: 'code', adapterSerial: 'SN', pollingIntervalMs: 30_000,
};

describe('normalizeConfig', () => {
  it('fills defaults and drops malformed printer entries', () => {
    const cfg = normalizeConfig({
      version: 2, language: 'fr', role: 'admin',
      printers: [null, 'x', { name: 'no id' }, { id: 'a', adapterType: 'moonraker', pollingIntervalMs: 10 }],
    });
    expect(cfg.language).toBe('de');
    expect(cfg.role).toBeUndefined();
    expect(cfg.printers).toEqual([{
      id: 'a', adapterType: 'moonraker', name: 'Drucker', flowntAuthToken: '', adapterUrl: '',
      adapterApiKey: '', adapterSerial: '', pollingIntervalMs: 30_000,
    }]);
  });

  it('keeps valid fields and optional settings', () => {
    const cfg = normalizeConfig({ version: 2, language: 'en', role: 'both', labelPrinter: 'Dymo', printers: [{ ...printer, smartPlugType: 'shelly', smartPlugUrl: '1.2.3.4' }] });
    expect(cfg).toEqual({ version: 2, language: 'en', role: 'both', labelPrinter: 'Dymo', printers: [{ ...printer, smartPlugType: 'shelly', smartPlugUrl: '1.2.3.4' }] });
  });

  it('survives a missing printers list', () => {
    expect(normalizeConfig({ version: 2 }).printers).toEqual([]);
  });
});

describe('loadMultiConfig / saveMultiConfig', () => {
  it('returns an empty config when no file exists', () => {
    expect(loadMultiConfig()).toEqual({ version: 2, language: 'de', printers: [] });
  });

  it('round-trips and writes the file owner-only', () => {
    const cfg = { version: 2 as const, language: 'en' as const, printers: [printer as never] };
    saveMultiConfig(cfg);
    expect(loadMultiConfig()).toEqual(cfg);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['config.json']); // no leftover tmp file
  });

  it('migrates the legacy single-printer format and persists it', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ flowntAuthToken: 'tok', adapterType: 'moonraker', adapterUrl: 'http://pi' }));
    const cfg = loadMultiConfig();
    expect(cfg.printers).toHaveLength(1);
    expect(cfg.printers[0]).toMatchObject({ name: 'Klipper Drucker', flowntAuthToken: 'tok', adapterType: 'moonraker', pollingIntervalMs: 30_000 });
    expect(JSON.parse(readFileSync(file, 'utf-8')).version).toBe(2);
  });

  it('moves a corrupt file aside instead of letting the next save overwrite it', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '{ "version": 2, "printers": [ ');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadMultiConfig().printers).toEqual([]);
    const files = readdirSync(dir);
    expect(files.some(f => f.startsWith('config.json.broken-'))).toBe(true);
    expect(files).not.toContain('config.json');
  });
});
