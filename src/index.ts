import open from 'open';
import { loadMultiConfig, PrinterConfig } from './config.js';
import { MoonrakerAdapter } from './adapters/moonraker.js';
import { PrusaLinkAdapter } from './adapters/prusa.js';
import { BambuAdapter } from './adapters/bambu.js';
import { startServer, printerStates, PrinterBridgeState, PORT } from './server.js';
import { runBridge } from './bridge.js';
import { Adapter } from './adapters/types.js';
import { BRIDGE_VERSION } from './version.js';
import { addEvent } from './events.js';

const URL = `http://localhost:${PORT}`;

console.log(`[flownt-bridge] v${BRIDGE_VERSION} startet…`);

function buildAdapter(cfg: PrinterConfig): Adapter {
  if (cfg.adapterType === 'bambu') {
    if (!cfg.adapterSerial) throw new Error(`[${cfg.name}] Seriennummer fehlt in der Konfiguration.`);
    return new BambuAdapter(cfg.adapterUrl, cfg.adapterSerial, cfg.adapterApiKey, cfg.id);
  }
  if (cfg.adapterType === 'moonraker') {
    return new MoonrakerAdapter(cfg.adapterUrl, cfg.adapterApiKey);
  }
  if (cfg.adapterType === 'prusa') {
    return new PrusaLinkAdapter(cfg.adapterUrl, cfg.adapterApiKey);
  }
  throw new Error(`Unbekannter Adapter: ${cfg.adapterType}`);
}

function makePrinterState(): PrinterBridgeState {
  return { snapshot: null, lastPushAt: null, running: false, error: null, adapter: null };
}

const runningBridges = new Map<string, () => void>();

function startPrinter(cfg: PrinterConfig): void {
  // Stop existing instance if already running
  runningBridges.get(cfg.id)?.();

  let state = printerStates.get(cfg.id);
  if (!state) {
    state = makePrinterState();
    printerStates.set(cfg.id, state);
  }
  let adapter: Adapter;
  try {
    adapter = buildAdapter(cfg);
  } catch (err) {
    // Ungültige Konfiguration eines Druckers darf den Start der übrigen nicht verhindern.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[flownt-bridge] ${msg}`);
    runningBridges.delete(cfg.id);
    state.running = false;
    state.adapter = null;
    state.error   = msg;
    addEvent(cfg.id, 'warn', msg);
    return;
  }
  state.running = true;
  state.error   = null;
  state.adapter = adapter;

  let cancelled = false;
  runningBridges.set(cfg.id, () => {
    cancelled = true;
    state!.running = false;
    // Adapter mit abbauen: sonst reconnectet der alte MQTT-Client ewig weiter und
    // kämpft am A1/P1 mit dem neuen um den einzigen lokalen Verbindungs-Slot.
    adapter.dispose?.();
  });

  runBridge(adapter, cfg, state, () => cancelled).catch(err => {
    state!.error   = String(err);
    state!.running = false;
  });
  console.log(`[flownt-bridge] Drucker gestartet: ${cfg.name}`);
}

function stopPrinter(id: string): void {
  runningBridges.get(id)?.();
  runningBridges.delete(id);
  const state = printerStates.get(id);
  if (state) state.running = false;
}

// Start web UI
startServer({
  onAdd(cfg) {
    startPrinter(cfg);
  },
  onUpdate(cfg) {
    // Restart with updated config
    startPrinter(cfg);
  },
  onDelete(id) {
    stopPrinter(id);
    printerStates.delete(id);
  },
});

// Start all configured printers immediately
const existing = loadMultiConfig();
if (existing.printers.length > 0) {
  console.log(`[flownt-bridge] ${existing.printers.length} Drucker gefunden. Starte alle…`);
  for (const printer of existing.printers) {
    startPrinter(printer);
  }
  console.log(`[flownt-bridge] Status: ${URL}`);
} else {
  console.log(`[flownt-bridge] Noch nicht eingerichtet. Öffne ${URL} im Browser…`);
  const isHeadless = process.platform === 'linux' && !process.env.DISPLAY;
  if (!isHeadless) open(`${URL}/`).catch(() => {});
}
