import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export const FLOWNT_EDGE_URL = 'https://qvlmidtunxthqsxfutkq.supabase.co/functions/v1';

export type BridgeLang = 'de' | 'en';

export type SmartPlugType = 'shelly';

export interface PrinterConfig {
  id: string;
  name: string;
  flowntAuthToken: string;
  adapterType: 'bambu' | 'moonraker' | 'prusa';
  adapterUrl: string;
  adapterApiKey: string;
  adapterSerial: string;
  pollingIntervalMs: number;
  bambuCloudEmail?: string;
  bambuCloudPassword?: string;
  // Optionaler Smart-Plug zur echten Strommessung (Shelly Gen1 + Gen2/3/4, Auto-Erkennung).
  smartPlugType?: SmartPlugType;
  smartPlugUrl?: string; // IP/Host des Shelly im LAN, z. B. "192.168.178.50"
}

export type BridgeRole = 'monitor' | 'label' | 'both';

export interface MultiConfig {
  version: 2;
  language: BridgeLang;
  printers: PrinterConfig[];
  role?: BridgeRole;       // was diese Bridge-Instanz tun soll (Web-UI-Rollenwahl, Phase 2)
  labelPrinter?: string;   // ausgewählter Etikettendrucker (System-/CUPS-Name)
}

const CONFIG_DIR  = join(homedir(), '.flownt-bridge');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function migrate(raw: Record<string, unknown>): MultiConfig {
  const printer: PrinterConfig = {
    id: randomUUID(),
    name: raw.adapterType === 'bambu' ? 'Bambu Lab Drucker' : 'Klipper Drucker',
    flowntAuthToken: (raw.flowntAuthToken ?? '') as string,
    adapterType: (raw.adapterType ?? 'bambu') as 'bambu' | 'moonraker' | 'prusa',
    adapterUrl: (raw.adapterUrl ?? '') as string,
    adapterApiKey: (raw.adapterApiKey ?? '') as string,
    adapterSerial: (raw.adapterSerial ?? '') as string,
    pollingIntervalMs: (raw.pollingIntervalMs ?? 30_000) as number,
    ...(raw.bambuCloudEmail    ? { bambuCloudEmail:    raw.bambuCloudEmail    as string } : {}),
    ...(raw.bambuCloudPassword ? { bambuCloudPassword: raw.bambuCloudPassword as string } : {}),
  };
  return {
    version: 2,
    language: 'de',
    printers: raw.flowntAuthToken ? [printer] : [],
  };
}

const DEFAULT_POLLING_MS = 30_000;
const MIN_POLLING_MS = 5_000;

const emptyConfig = (): MultiConfig => ({ version: 2, language: 'de', printers: [] });

/**
 * Bringt eine gelesene (ggf. von Hand editierte) v2-Konfiguration in eine sichere Form:
 * fehlende Listen/Felder werden ergänzt, Nicht-Objekte bzw. Einträge ohne id verworfen.
 * Ungültige Adapter-Typen bleiben erhalten — index.ts meldet sie pro Drucker als Fehler.
 */
export function normalizeConfig(raw: Record<string, unknown>): MultiConfig {
  const printers = Array.isArray(raw.printers) ? raw.printers : [];
  const role = raw.role === 'monitor' || raw.role === 'label' || raw.role === 'both' ? raw.role : undefined;
  return {
    version: 2,
    language: raw.language === 'en' ? 'en' : 'de',
    printers: printers
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
      .map(p => {
        const polling = Number(p.pollingIntervalMs);
        return {
          ...(p as unknown as PrinterConfig),
          name: typeof p.name === 'string' && p.name ? p.name : 'Drucker',
          flowntAuthToken: typeof p.flowntAuthToken === 'string' ? p.flowntAuthToken : '',
          adapterUrl: typeof p.adapterUrl === 'string' ? p.adapterUrl : '',
          adapterApiKey: typeof p.adapterApiKey === 'string' ? p.adapterApiKey : '',
          adapterSerial: typeof p.adapterSerial === 'string' ? p.adapterSerial : '',
          bambuCloudEmail: typeof p.bambuCloudEmail === 'string' ? p.bambuCloudEmail : undefined,
          bambuCloudPassword: typeof p.bambuCloudPassword === 'string' ? p.bambuCloudPassword : undefined,
          smartPlugUrl: typeof p.smartPlugUrl === 'string' ? p.smartPlugUrl : undefined,
          pollingIntervalMs: Number.isFinite(polling) && polling >= MIN_POLLING_MS ? polling : DEFAULT_POLLING_MS,
        };
      }),
    ...(role ? { role } : {}),
    ...(typeof raw.labelPrinter === 'string' && raw.labelPrinter ? { labelPrinter: raw.labelPrinter } : {}),
  };
}

export function loadMultiConfig(): MultiConfig {
  if (!existsSync(CONFIG_FILE)) return emptyConfig();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') throw new Error('kein JSON-Objekt');
  } catch (err) {
    // Kaputte Datei NICHT still als „leer" behandeln: der nächste Speichervorgang würde
    // sonst alle Drucker überschreiben. Zur Seite legen, dann leer weitermachen.
    // Schlägt das Verschieben fehl, abbrechen statt leer weiterzumachen — sonst wäre die
    // einzige (reparierbare) Kopie beim nächsten Speichern weg.
    const backup = `${CONFIG_FILE}.broken-${Date.now()}`;
    renameSync(CONFIG_FILE, backup);
    console.error(`[config] ${CONFIG_FILE} ist unlesbar (${String(err)}) — verschoben nach ${backup}`);
    return emptyConfig();
  }
  if (raw.version === 2) return normalizeConfig(raw);
  // Legacy single-printer format → auto-migrate and persist
  const cfg = migrate(raw);
  saveMultiConfig(cfg);
  return cfg;
}

export function saveMultiConfig(cfg: MultiConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Atomar schreiben (tmp + rename): ein Absturz mitten im Schreiben hinterlässt sonst
  // eine halbe Datei. 0600, weil Access Codes/Passwörter drinstehen.
  const tmp = join(CONFIG_DIR, `.config.json.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, CONFIG_FILE);
}

export function newPrinterId(): string {
  return randomUUID();
}
