// Offline execution of the production bridge module with I/O imports stubbed.
// Requires Node 24+ for its built-in TypeScript stripping; no printer/cloud calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

function loadBridge(fetch) {
  const deadlines = [];
  const events = [];
  const source = stripTypeScriptTypes(readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?$/gm, '')
    .replace('export async function runBridge', 'async function runBridge');
  const context = {
    fetch, FLOWNT_EDGE_URL: 'https://example.invalid', BRIDGE_VERSION: 'test',
    BambuCloudClient: class {}, ShellyClient: class {},
    addEvent: (...args) => events.push(args),
    console: { log() {}, warn() {}, error() {} },
    AbortSignal: { timeout(ms) { deadlines.push(ms); return { deadline: ms }; } },
    setTimeout() { throw new Error('unexpected monitoring loop'); },
  };
  vm.runInNewContext(`${source}\nglobalThis.runBridge = runBridge;`, context);
  return { runBridge: context.runBridge, deadlines, events };
}

const cfg = { id: 'fixture', name: 'fixture', flowntAuthToken: 'synthetic-token' };
const adapter = { getSnapshot() { throw new Error('must not contact a printer'); } };

test('initial heartbeat carries the same 10-second bound as status pushes', async () => {
  let rejectRequest;
  let options;
  const b = loadBridge((_url, opts) => {
    options = opts;
    return new Promise((_resolve, reject) => { rejectRequest = reject; });
  });
  const state = {};
  const running = b.runBridge(adapter, cfg, state, () => true);
  assert.deepEqual(b.deadlines, [10000]);
  assert.equal(options.signal.deadline, 10000);
  rejectRequest(new Error('synthetic timeout'));
  await running;
  assert.equal(typeof state.error, 'string');
  assert.equal(b.events.at(-1)[1], 'warn');
});

test('successful startup preserves the heartbeat payload and success state', async () => {
  let options;
  const b = loadBridge(async (_url, opts) => { options = opts; return { ok: true }; });
  const state = { error: 'old error' };
  await b.runBridge(adapter, cfg, state, () => true);
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), {
    auth_token: 'synthetic-token', event_type: 'heartbeat', bridge_version: 'test',
  });
  assert.equal(state.error, null);
  assert.equal(b.events.at(-1)[1], 'success');
});
