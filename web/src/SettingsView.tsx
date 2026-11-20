import { useEffect, useState } from 'react';
import type { AppConfig, AppStatus } from '../../shared/types';
import { api } from './api';
import { Icon } from './icons';
import { toast } from './App';

type Cfg = AppConfig & { apiKeySet: boolean; openaiKeySet: boolean; cloudflareTokenSet: boolean };

const isOpenAI = (m: string) => /^(gpt|o\d)/i.test(m);

const MODELS = [
  { id: 'gpt-6-luna', note: 'OpenAI · cheapest by far; built for summarisation' },
  { id: 'claude-sonnet-5', note: 'Anthropic · strong reader, about 20× the price of Luna' },
  { id: 'claude-opus-5-5', note: 'Anthropic · most careful, highest cost' },
  { id: 'claude-haiku-4-5-20251001', note: 'Anthropic · cheap and fast' },
];

export function SettingsView({ status, onSaved }: { status: AppStatus | null; onSaved: () => void }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [key, setKey] = useState('');
  const [okey, setOkey] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.config().then(setCfg);
  }, []);
  if (!cfg) return <div className="page" />;

  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setCfg({ ...cfg, [k]: v });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const { apiKeySet: _k, openaiKeySet: _o, cloudflareTokenSet: _t, anthropicApiKey: _a, openaiApiKey: _b, cloudflareApiToken: _c, ...rest } = cfg!;
      const next = await api.saveConfig({
        ...rest,
        ...(key ? { anthropicApiKey: key.trim() } : {}),
        ...(okey ? { openaiApiKey: okey.trim() } : {}),
        ...(cfToken ? { cloudflareApiToken: cfToken.trim() } : {}),
      });
      setCfg(next as Cfg);
      setKey('');
      setOkey('');
      setCfToken('');
      toast('Settings saved');
      onSaved();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Stored locally in <code>~/Library/Application Support/exo-mind/config.json</code>. API keys never leave this machine except to call the model provider.</p>
        </div>
      </header>
      <form className="settings" onSubmit={save}>
        <fieldset>
          <legend>Source</legend>
          <label>
            <span>YouTube playlist link</span>
            <input value={cfg.playlistUrl} onChange={(e) => set('playlistUrl', e.target.value)} placeholder="https://www.youtube.com/playlist?list=…" />
            <small>
              Make the playlist <strong>Unlisted</strong> so it can be read without signing in. A Private playlist needs the browser cookies option below.
            </small>
          </label>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={cfg.autoPoll} onChange={(e) => set('autoPoll', e.target.checked)} />
              <span>Check automatically every</span>
            </label>
            <input className="num" type="number" min={1} value={cfg.pollMinutes} onChange={(e) => set('pollMinutes', Number(e.target.value))} />
            <span>minutes</span>
          </div>
        </fieldset>

        <fieldset>
          <legend>Model</legend>
          <label>
            <span>Model for summaries</span>
            <input value={cfg.model} onChange={(e) => set('model', e.target.value)} list="models" />
            <small>{MODELS.find((m) => m.id === cfg.model)?.note || 'Any model id works: gpt-… goes to OpenAI, claude-… to Anthropic.'}</small>
          </label>
          <label>
            <span>Model for finding connections</span>
            <input value={cfg.connectModel} onChange={(e) => set('connectModel', e.target.value)} list="models" placeholder="Same as summaries" />
            <small>Leave blank to use the summary model. Connection-finding is a small call, so a stronger model here costs little.</small>
          </label>
          <datalist id="models">
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.note}
              </option>
            ))}
          </datalist>
          {(isOpenAI(cfg.model) || isOpenAI(cfg.connectModel)) && (
            <label>
              <span>Reasoning effort (OpenAI)</span>
              <select value={cfg.reasoningEffort} onChange={(e) => set('reasoningEffort', e.target.value as Cfg['reasoningEffort'])}>
                <option value="none">None: fastest, cheapest</option>
                <option value="low">Low</option>
                <option value="medium">Medium (recommended)</option>
                <option value="high">High: slower, more thinking tokens</option>
              </select>
              <small>Thinking tokens are billed as output. They're included in the usage figures.</small>
            </label>
          )}
          <label>
            <span>OpenAI API key</span>
            <input type="password" value={okey} onChange={(e) => setOkey(e.target.value)} placeholder={cfg.openaiKeySet ? `Saved (${cfg.openaiApiKey}) — type to replace` : 'sk-…'} autoComplete="off" />
          </label>
          <label>
            <span>Anthropic API key</span>
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={cfg.apiKeySet ? `Saved (${cfg.anthropicApiKey}) — type to replace` : 'sk-ant-…'} autoComplete="off" />
            <small>Only the key for the provider you use is needed.</small>
          </label>
        </fieldset>

        <fieldset>
          <legend>Summaries</legend>
          <label>
            <span>About you (optional)</span>
            <textarea
              rows={3}
              value={cfg.aboutMe}
              onChange={(e) => set('aboutMe', e.target.value)}
              placeholder="e.g. Chaplain and theologian with interests in technology, ecology and patristics. Helps the model judge what's worth noticing."
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>Spending</legend>
          <div className="row">
            <span>Monthly budget</span>
            <span className="unit">US$</span>
            <input className="num" type="number" min={0} step={1} value={cfg.monthlyBudgetUsd} onChange={(e) => set('monthlyBudgetUsd', Number(e.target.value))} />
          </div>
          <small>Processing pauses once this month's model spend reaches the budget. 0 means no limit.</small>
          <div className="row">
            <span>Ask me first if one video or article would cost more than</span>
            <span className="unit">US$</span>
            <input className="num" type="number" min={0} step={0.25} value={cfg.maxCostPerItemUsd} onChange={(e) => set('maxCostPerItemUsd', Number(e.target.value))} />
          </div>
          <small>Estimated from transcript length before summarising. Catches multi-hour streams. 0 means never ask.</small>
        </fieldset>

        <fieldset>
          <legend>Storage</legend>
          <label>
            <span>Vault folder</span>
            <input value={cfg.vaultPath} onChange={(e) => set('vaultPath', e.target.value)} />
            <small>Plain markdown files: notes/, transcripts/. Point it at an iCloud or Dropbox folder to back it up. Changing this switches vaults. It doesn't move files.</small>
          </label>
        </fieldset>

        <fieldset>
          <legend>Sharing</legend>
          <small>
            Share a note as a read-only public page (Share button on a note). Pages are stored in Cloudflare KV and served by the Pages site in <code>cloudflare/</code>. Setup steps are in the README.
          </small>
          <label>
            <span>Address of the share site</span>
            <input value={cfg.shareBaseUrl} onChange={(e) => set('shareBaseUrl', e.target.value)} placeholder="https://notes.example.com" />
          </label>
          <label>
            <span>Cloudflare account ID</span>
            <input value={cfg.cloudflareAccountId} onChange={(e) => set('cloudflareAccountId', e.target.value.trim())} autoComplete="off" />
          </label>
          <label>
            <span>KV namespace ID</span>
            <input value={cfg.cloudflareKvNamespaceId} onChange={(e) => set('cloudflareKvNamespaceId', e.target.value.trim())} autoComplete="off" />
          </label>
          <label>
            <span>Cloudflare API token</span>
            <input
              type="password"
              value={cfToken}
              onChange={(e) => setCfToken(e.target.value)}
              placeholder={cfg.cloudflareTokenSet ? `Saved (${cfg.cloudflareApiToken}) — type to replace` : 'Token with Workers KV Storage: Edit'}
              autoComplete="off"
            />
            <small>Only needs the “Workers KV Storage: Edit” permission.</small>
          </label>
        </fieldset>

        <fieldset>
          <legend>yt-dlp</legend>
          <div className="ytdlp-status">
            {status?.ytdlp.ok ? (
              <span className="ok-text">
                <Icon name="check" size={14} /> yt-dlp {status.ytdlp.version}
              </span>
            ) : (
              <span className="err-text">
                <Icon name="alert" size={14} /> {status?.ytdlp.error || 'not found'}. Install it with <code>brew install yt-dlp</code>.
              </span>
            )}
          </div>
          <label>
            <span>Path to yt-dlp</span>
            <input value={cfg.ytdlpPath} onChange={(e) => set('ytdlpPath', e.target.value)} />
          </label>
          <label>
            <span>Use cookies from browser</span>
            <select value={cfg.cookiesFromBrowser} onChange={(e) => set('cookiesFromBrowser', e.target.value)}>
              <option value="">Don't (public & unlisted playlists)</option>
              <option value="chrome">Chrome</option>
              <option value="safari">Safari</option>
              <option value="firefox">Firefox</option>
              <option value="brave">Brave</option>
              <option value="edge">Edge</option>
            </select>
            <small>Needed for private playlists, or if YouTube starts asking yt-dlp to “confirm you're not a bot”.</small>
          </label>
          <label>
            <span>Caption languages</span>
            <input value={cfg.subLangs} onChange={(e) => set('subLangs', e.target.value)} />
            <small>
              yt-dlp <code>--sub-langs</code> pattern. <code>en.*</code> covers English and English auto-captions.
            </small>
          </label>
        </fieldset>

        <div className="settings-save">
          <button className="btn btn-primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
