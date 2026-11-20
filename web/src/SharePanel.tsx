import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SHARE_OPTIONS, type NoteMeta, type ShareOptions, type ShareRecord } from '../../shared/types';
import { api } from './api';
import { Icon } from './icons';
import { toast } from './App';
import { cx, fmtRelative } from './util';

const CHOICES: { key: keyof ShareOptions; label: string; hint: string; when?: (m: NoteMeta) => boolean }[] = [
  { key: 'peopleGraph', label: 'People graph', hint: 'Who speaks and who they talk about', when: (m) => !!m.people?.length },
  { key: 'tags', label: 'Tags', hint: '', when: (m) => m.tags.length > 0 },
  { key: 'works', label: 'Works', hint: 'Books and papers mentioned', when: (m) => !!m.works?.length },
  { key: 'transcript', label: 'Transcript', hint: 'The full text, with timestamps', when: (m) => !!m.transcript && m.transcript_source !== 'none' },
  { key: 'myNotes', label: 'My notes', hint: 'Your own section of the note' },
  { key: 'otherNotes', label: 'My other notes', hint: 'Titles of connected notes, and where people come up elsewhere' },
];

/** The Share button and its panel: choose what the public page shows, publish, copy, unshare. */
export function SharePanel({ slug, meta }: { slug: string; meta: NoteMeta }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ configured: boolean; share: ShareRecord | null } | null>(null);
  const [opts, setOpts] = useState<ShareOptions>(DEFAULT_SHARE_OPTIONS);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setState(null);
    api.share(slug).then((s) => {
      setState(s);
      setOpts(s.share?.options || DEFAULT_SHARE_OPTIONS);
    }, () => {});
  }, [slug]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('mousedown', onDown);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('mousedown', onDown);
      removeEventListener('keydown', onKey);
    };
  }, [open]);

  const share = state?.share;
  const changed = !!share && CHOICES.some((c) => share.options[c.key] !== opts[c.key]);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast(url);
    }
  }

  async function publish() {
    setBusy(true);
    try {
      const rec = await api.publishShare(slug, opts);
      setState({ configured: true, share: rec });
      await copy(rec.url);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function unshare() {
    if (!confirm('Stop sharing this note? The link will stop working.')) return;
    setBusy(true);
    try {
      await api.unshare(slug);
      setState((s) => (s ? { ...s, share: null } : s));
      toast('No longer shared');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const choices = CHOICES.filter((c) => !c.when || c.when(meta));

  return (
    <div className="menu-wrap" ref={wrap}>
      <button className={cx('btn', share && 'btn-shared')} onClick={() => setOpen(!open)} aria-expanded={open} title={share ? `Shared at ${share.url}` : 'Share a read-only page of this note'}>
        <Icon name="share" size={14} /> {share ? 'Shared' : 'Share'}
      </button>
      {open && (
        <div className="menu share-panel">
          {!state ? (
            <div className="share-loading" />
          ) : !state.configured ? (
            <p className="share-note">
              Sharing isn't set up yet. Add your Cloudflare details under <a href="#/settings">Settings → Sharing</a>.
            </p>
          ) : (
            <>
              <div className="share-h">Public page shows</div>
              <div className="share-always">Title, source, speakers and the summary</div>
              {choices.map((c) => (
                <label key={c.key} className="share-opt">
                  <input type="checkbox" checked={opts[c.key]} onChange={(e) => setOpts({ ...opts, [c.key]: e.target.checked })} />
                  <span>
                    {c.label}
                    {c.hint && <small>{c.hint}</small>}
                  </span>
                </label>
              ))}
              {share && (
                <div className="share-link">
                  <input readOnly value={share.url} onFocus={(e) => e.target.select()} aria-label="Share link" />
                  <button className="btn btn-icon" onClick={() => copy(share.url)} title="Copy link" aria-label="Copy link">
                    <Icon name="link" size={14} />
                  </button>
                </div>
              )}
              {share && <div className="share-note">Published {fmtRelative(share.sharedAt)}. Edits to the note show up once you update.</div>}
              <div className="share-actions">
                <button className="btn btn-primary" onClick={publish} disabled={busy}>
                  {busy ? 'Publishing…' : share ? (changed ? 'Update page' : 'Update with latest edits') : 'Publish & copy link'}
                </button>
                {share && (
                  <>
                    <a className="btn" href={share.url} target="_blank" rel="noreferrer">
                      <Icon name="external" size={14} /> Open
                    </a>
                    <button className="btn btn-ghost-danger" onClick={unshare} disabled={busy}>
                      Unshare
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
