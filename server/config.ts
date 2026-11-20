import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../shared/types.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// App data (config incl. API keys, usage log, shares). Kept outside the vault so the vault can be
// synced/shared safely, and outside the checkout so the Mac app and `npm run dev` share one copy:
// ~/Library/Application Support/exo-mind, the same folder Electron's userData points at.
function appDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'exo-mind');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'exo-mind');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'exo-mind');
}
export const DATA_DIR = process.env.EXO_DATA_DIR || appDataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Before 0.4 the data lived in the checkout's data/ folder. Copied across once (never moved, so the
// old folder is still there to fall back on). The packaged app has no checkout beside it, so the
// build records where it was built from and the app passes that in as EXO_LEGACY_DATA.
function migrateLegacyData() {
  const legacy = process.env.EXO_LEGACY_DATA || path.join(ROOT, 'data');
  if (fs.existsSync(CONFIG_FILE) || !fs.existsSync(path.join(legacy, 'config.json'))) return;
  if (path.resolve(legacy) === path.resolve(DATA_DIR)) return;
  fs.cpSync(legacy, DATA_DIR, { recursive: true });
  console.log(`[config] copied app data from ${legacy} to ${DATA_DIR}`);
}

const DEFAULTS: AppConfig = {
  playlistUrl: '',
  pollMinutes: 15,
  autoPoll: true,
  paused: false,
  // A fresh Mac app has no checkout to keep a vault in, so it passes a default under ~/Documents.
  vaultPath: process.env.EXO_DEFAULT_VAULT || path.join(ROOT, 'vault'),
  anthropicApiKey: '',
  openaiApiKey: '',
  model: 'gpt-6-luna',
  connectModel: '',
  reasoningEffort: 'medium',
  ytdlpPath: 'yt-dlp',
  cookiesFromBrowser: '',
  subLangs: 'en.*',
  aboutMe: '',
  monthlyBudgetUsd: 20,
  maxCostPerItemUsd: 1,
  cloudflareAccountId: '',
  cloudflareKvNamespaceId: '',
  cloudflareApiToken: '',
  shareBaseUrl: '',
};

let current: AppConfig = load();

function load(): AppConfig {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    migrateLegacyData();
  } catch (e) {
    console.error('[config] could not copy the old data/ folder across', e);
  }
  let fromFile: Partial<AppConfig> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error('[config] could not parse config.json, using defaults', e);
    }
  }
  const cfg = { ...DEFAULTS, ...fromFile };
  // Environment variables fill gaps (handy for a .env or shell profile).
  if (!cfg.anthropicApiKey && process.env.ANTHROPIC_API_KEY) cfg.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!cfg.openaiApiKey && process.env.OPENAI_API_KEY) cfg.openaiApiKey = process.env.OPENAI_API_KEY;
  if (!cfg.playlistUrl && process.env.EXO_PLAYLIST) cfg.playlistUrl = process.env.EXO_PLAYLIST;
  if (process.env.EXO_VAULT) cfg.vaultPath = process.env.EXO_VAULT;
  if (process.env.EXO_YTDLP) cfg.ytdlpPath = process.env.EXO_YTDLP;
  if (!cfg.cloudflareApiToken && process.env.CLOUDFLARE_API_TOKEN) cfg.cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!cfg.cloudflareAccountId && process.env.CLOUDFLARE_ACCOUNT_ID) cfg.cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  cfg.vaultPath = expandHome(cfg.vaultPath);
  return cfg;
}

export function expandHome(p: string) {
  if (p.startsWith('~')) return path.join(process.env.HOME || '', p.slice(1));
  return path.resolve(ROOT, p);
}

export function getConfig(): AppConfig {
  return current;
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...current, ...patch };
  if (patch.vaultPath) next.vaultPath = expandHome(patch.vaultPath);
  next.pollMinutes = Math.max(1, Number(next.pollMinutes) || DEFAULTS.pollMinutes);
  current = next;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2));
  return current;
}

/** Config safe to send to the browser. */
const mask = (k: string) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : '');

export function publicConfig(): AppConfig & { apiKeySet: boolean; openaiKeySet: boolean; cloudflareTokenSet: boolean } {
  return {
    ...current,
    anthropicApiKey: mask(current.anthropicApiKey),
    openaiApiKey: mask(current.openaiApiKey),
    cloudflareApiToken: mask(current.cloudflareApiToken),
    cloudflareTokenSet: !!current.cloudflareApiToken,
    apiKeySet: !!current.anthropicApiKey,
    openaiKeySet: !!current.openaiApiKey,
  };
}
