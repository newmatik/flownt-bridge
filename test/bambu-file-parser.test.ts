import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseFileBuffer } from '../src/adapters/bambu-file-parser.js';

const zip = (files: Record<string, string>) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

describe('parseFileBuffer — 3MF', () => {
  it('reads used_g, slicer filament id and colour from Bambu slice_info.config', () => {
    const buf = zip({
      'Metadata/slice_info.config': `<config><plate>
        <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FF6600" used_m="1.2" used_g="3.456"/>
        <filament id="3" type="PETG" color="#00FF00FF" used_g="10"/>
        <filament id="4" type="PLA" color="#000000" used_g="0"/>
      </plate></config>`,
    });
    expect(parseFileBuffer('/cache/Model.gcode.3mf', buf)).toEqual([
      { filamentIndex: 1, grams: 3.46, color: '#FF6600' },
      { filamentIndex: 3, grams: 10, color: '#00FF00FF' },
    ]);
  });

  it('falls back to PrusaSlicer Slic3r_PE.config (0-based order)', () => {
    const buf = zip({ 'Metadata/Slic3r_PE.config': '; filament_used_g = 1.5;0;2.25\n' });
    expect(parseFileBuffer('a.3mf', buf)).toEqual([
      { filamentIndex: 0, grams: 1.5 },
      { filamentIndex: 2, grams: 2.25 },
    ]);
  });

  it('falls back to an embedded G-code file', () => {
    const buf = zip({ 'Metadata/plate_1.gcode': '; filament used [g] = 4.2\nG1 X0\n' });
    expect(parseFileBuffer('a.gcode.3mf', buf)).toEqual([{ filamentIndex: 0, grams: 4.2 }]);
  });

  it('returns [] for a corrupt archive instead of throwing', () => {
    expect(parseFileBuffer('a.3mf', Buffer.from('not a zip'))).toEqual([]);
  });
});

describe('parseFileBuffer — G-code', () => {
  const g = (s: string) => Buffer.from(s, 'utf-8');

  it('parses multi-filament "filament used [g]" and drops zero entries', () => {
    expect(parseFileBuffer('x.gcode', g('; filament used [g] = 0.76, 0, 18.38\n; filament used [cm] = 1, 2, 3\n')))
      .toEqual([{ filamentIndex: 0, grams: 0.76 }, { filamentIndex: 2, grams: 18.38 }]);
  });

  it('does not read past the end of the line', () => {
    expect(parseFileBuffer('x.gcode', g('; filament used [g] = 1.5\n2.5 stray\n'))).toEqual([{ filamentIndex: 0, grams: 1.5 }]);
  });

  it('parses PrusaSlicer filament_used_in_weight', () => {
    expect(parseFileBuffer('x.gco', g('; filament_used_in_weight = 12.45; 5.67\n')))
      .toEqual([{ filamentIndex: 0, grams: 12.45 }, { filamentIndex: 1, grams: 5.67 }]);
  });

  it('parses Cura-style "filament used = N g"', () => {
    expect(parseFileBuffer('x.g', g(';filament used = 2.34 g\n'))).toEqual([{ filamentIndex: 0, grams: 2.34 }]);
  });

  it('returns [] when no weight is present', () => {
    expect(parseFileBuffer('x.gcode', g('G28\nG1 X10\n'))).toEqual([]);
  });
});

describe('parseFileBuffer — other formats', () => {
  it('scans uncompressed .bgcode metadata (best effort)', () => {
    const buf = Buffer.concat([Buffer.from([0x47, 0x43, 0x44, 0x45, 0, 1]), Buffer.from('filament used [g]=7.5, 1.25\nother=1')]);
    expect(parseFileBuffer('x.bgcode', buf)).toEqual([{ filamentIndex: 0, grams: 7.5 }, { filamentIndex: 1, grams: 1.25 }]);
  });

  it('returns [] for unknown extensions', () => {
    expect(parseFileBuffer('x.stl', Buffer.from('; filament used [g] = 1'))).toEqual([]);
  });
});
