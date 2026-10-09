import { describe, expect, it } from 'vitest';
import { safeReturnUrl } from '../src/server.js';

describe('safeReturnUrl', () => {
  it('allows local paths', () => {
    expect(safeReturnUrl('/setup/abc')).toBe('/setup/abc');
    expect(safeReturnUrl('/')).toBe('/');
  });

  it('rejects external or malformed targets', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'setup', '', undefined, ['/x']]) {
      expect(safeReturnUrl(bad)).toBe('/');
    }
  });
});
