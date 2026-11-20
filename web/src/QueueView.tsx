import { useEffect, useRef, useState } from 'react';
import type { AppStatus, QueueItem } from '../../shared/types';
import { api } from './api';
import { Icon } from './icons';
import { toast } from './App';
import { cx, fmtRelative, fmtUsd, href } from './util';

const LABEL: Record<QueueItem['kind'], string> = { ingest: 'New', resummarise: 'Re-summarise', reconnect: 'Connections' };

export function QueueView({ queue, status, reload }: { queue: QueueItem[]; status: AppStatus | null; reload: () => void }) {
  const [polling, setPolling] = useState(false);
  const [broken, setBroken] = useState<{ notes: { slug: string; title: string }[]; estimate: number } | null>(null);
  const open = queue.filter((q) => q.status === 'processing' || q.status === 'queued' || q.status === 'error');

  useEffect(() => {
    api.maintenance().then(setBroken).catch(() => {});
  }, [queue.length, status?.working]);

  async function fixBroken() {
    const r = await api.fixBroken();
    toast(`Re-summarising ${r.queued} note${r.queued === 1 ? '' : 's'}`);
    reload();
    setBroken(null);
  }
  const done = queue.filter((q) => !open.includes(q));

  async function pollNow() {
    setPolling(true);
    try {
      await api.poll();
      reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setPolling(false);
    }
  }

  async function togglePause() {
    await api.saveConfig({ paused: !status?.paused });
    reload();
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Queue</h1>
          <p className="muted">New items in your playlist are picked up, transcribed, summarised and linked, one at a time.</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={togglePause} disabled={!status}>
            <Icon name={status?.paused ? 'play' : 'pause'} size={14} /> {status?.paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn btn-primary" onClick={pollNow} disabled={polling || !status?.playlistUrl}>
            <Icon name="refresh" size={14} className={polling || status?.polling ? 'spin' : ''} /> Check playlist now
          </button>
        </div>
      </header>

      {status && <Setup status={status} />}

      {status?.overBudget && (
        <div className="banner banner-warn">
          <Icon name="alert" size={16} />
          <div>
            <strong>Monthly budget reached ({fmtUsd(status.monthSpend, 2)} of {fmtUsd(status.budget, 0)}).</strong> Nothing new is summarised until next month
            or until you raise the budget in <a href="#/settings">Settings</a>.
          </div>
        </div>
      )}

      {status?.youtubeWaitUntil && (
        <div className="banner">
          <Icon name="alert" size={16} />
          <div>
            <strong>YouTube asked us to slow down.</strong> Fetching resumes automatically at{' '}
            {new Date(status.youtubeWaitUntil).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' })}. Setting <em>Use cookies from browser</em>{' '}
            in Settings usually makes this rarer.
          </div>
        </div>
      )}

      {broken && broken.notes.length > 0 && (
        <div className="banner">
          <Icon name="sparkle" size={16} />
          <div className="grow">
            <strong>
              {broken.notes.length} note{broken.notes.length === 1 ? '' : 's'} came out malformed
            </strong>{' '}
            (stray markup or no tags) from the earlier bug. Re-summarising reuses the saved transcripts
            {broken.estimate > 0 && <> and should cost about {fmtUsd(broken.estimate, 2)}</>}. “My notes” sections are kept.
          </div>
          <button className="btn btn-sm btn-primary" onClick={fixBroken}>
            Re-summarise {broken.notes.length}
          </button>
        </div>
      )}

      {status?.playlistUrl && (
        <div className="poll-info">
          <span>
            Watching{' '}
            <a href={status.playlistUrl} target="_blank" rel="noreferrer">
              your playlist
            </a>
          </span>
          {status.lastPoll && <span>last checked {fmtRelative(status.lastPoll)}</span>}
          {status.nextPoll && status.autoPoll && !status.paused && <span>next check {fmtRelative(status.nextPoll)}</span>}
          {!status.autoPoll && <span>automatic checks off</span>}
          {status.lastPollError && (
            <span className="err-text">
              <Icon name="alert" size={13} /> {status.lastPollError}
            </span>
          )}
        </div>
      )}

      <section className="q-section">
        <h2 className="section-h">In progress & waiting</h2>
        {open.length === 0 ? (
          <p className="muted">Nothing waiting. Add a video to your playlist, or paste a video or article link at top left.</p>
        ) : (
          <ul className="q-list">
            {open.map((q) => (
              <QRow key={q.id} q={q} reload={reload} />
            ))}
          </ul>
        )}
      </section>

      {done.length > 0 && (
        <section className="q-section">
          <div className="section-h-row">
            <h2 className="section-h">Recently finished</h2>
            <button className="btn btn-sm" onClick={() => api.clearQueue().then(reload)}>
              Clear
            </button>
          </div>
          <ul className="q-list">
            {done.slice(0, 60).map((q) => (
              <QRow key={q.id} q={q} reload={reload} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function QRow({ q, reload }: { q: QueueItem; reload: () => void }) {
  const [pasting, setPasting] = useState(false);
  const canPaste = q.kind === 'ingest' && !!q.url && !q.needsApproval && (q.status === 'error' || q.status === 'skipped');
  // Skipped links never become notes, so there's nothing to star unless the note already exists.
  const canStar = q.status !== 'skipped' || !!q.slug;
  const [starred, setStarred] = useState(!!q.starred);
  useEffect(() => setStarred(!!q.starred), [q.starred]);
  const [invest, setInvest] = useState(!!q.invest);
  useEffect(() => setInvest(!!q.invest), [q.invest]);

  async function toggleInvest() {
    const on = !invest;
    setInvest(on);
    try {
      await api.investQueued(q.id, on);
      reload();
    } catch (e) {
      setInvest(!on);
      toast((e as Error).message, 'error');
    }
  }

  async function toggleStar() {
    const on = !starred;
    setStarred(on);
    try {
      await api.starQueued(q.id, on);
      reload();
    } catch (e) {
      setStarred(!on);
      toast((e as Error).message, 'error');
    }
  }
  return (
    <li className={cx('q-row', `q-row-${q.status}`)}>
      <span className={cx('q-status', q.status)}>{q.status === 'processing' ? <span className="spinner" /> : null}{q.status}</span>
      <div className="q-main">
        <div className="q-title">
          {q.slug && (q.status === 'done' || q.status === 'error') ? <a href={href({ slug: q.slug })}>{q.title || q.id}</a> : q.title || q.url || q.id}
        </div>
        <div className="q-sub">
          <span className="q-kind">{LABEL[q.kind]}</span>
          <span>{q.source === 'playlist' ? 'from playlist' : q.source === 'manual' ? 'pasted link' : 'from app'}</span>
          <span>{fmtRelative(q.finishedAt || q.queuedAt)}</span>
          {q.step && q.status === 'processing' && <span className="q-step">{q.step}…</span>}
          {q.status === 'queued' && q.retryAt && (
            <span className="q-step">
              {q.step} · next try {new Date(q.retryAt).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
          {q.estimate != null && q.estimate > 0 && <span>≈ {fmtUsd(q.estimate)}</span>}
        </div>
        {q.error && <div className="q-error">{q.error}</div>}
        {pasting && canPaste && (
          <PasteForm
            q={q}
            onDone={() => {
              setPasting(false);
              reload();
            }}
            onCancel={() => setPasting(false)}
          />
        )}
      </div>
      <div className="q-actions">
        {canStar && (
          <button
            className={cx('q-star', starred && 'on')}
            onClick={toggleStar}
            aria-pressed={starred}
            aria-label={starred ? 'Unstar' : 'Star'}
            title={starred ? 'Starred' : q.status === 'done' ? 'Star this note' : 'Star the note when it’s ready'}
          >
            <Icon name="star" size={15} fill={starred} />
          </button>
        )}
        {canStar && (
          <button
            className={cx('q-star', 'q-invest', invest && 'on')}
            onClick={toggleInvest}
            aria-pressed={invest}
            aria-label={invest ? 'Remove the investment tag' : 'Tag “investment”'}
            title={invest ? 'Tagged “investment”' : q.status === 'done' ? 'Tag this note “investment”' : 'Tag the note “investment” when it’s ready'}
          >
            <Icon name="invest" size={15} />
          </button>
        )}
        {q.needsApproval && q.status === 'error' && (
          <button className="btn btn-sm btn-primary" onClick={() => api.retry(q.id, true).then(reload)}>
            Approve{q.estimate ? ` ${fmtUsd(q.estimate)}` : ''}
          </button>
        )}
        {canPaste && !pasting && (
          <button className="btn btn-sm" onClick={() => setPasting(true)} title="Copy the article from the page in your browser and paste it here">
            Paste text
          </button>
        )}
        {((q.status === 'error' && !q.needsApproval) || q.status === 'skipped') && (
          <button className="btn btn-sm" onClick={() => api.retry(q.id).then(reload)}>
            Retry
          </button>
        )}
        {(q.status === 'queued' || q.status === 'error') && (
          <button className="btn btn-sm" onClick={() => api.skip(q.id).then(reload)}>
            Skip
          </button>
        )}
      </div>
    </li>
  );
}

/** For pages that block automated readers: the user copies the article in their browser and pastes it here. */
function PasteForm({ q, onDone, onCancel }: { q: QueueItem; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(q.title && q.title !== q.url && !/^https?:\/\//.test(q.title) ? q.title : '');
  const [author, setAuthor] = useState('');
  const [published, setPublished] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // The clipboard's HTML keeps paragraph breaks and headings and lets Readability drop menus.
  // It only matches the text while the box holds exactly one paste, so any other edit drops it.
  const html = useRef<string | undefined>(undefined);
  const pastedText = useRef<string | null>(null);
  const words = text.split(/\s+/).filter(Boolean).length;

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const h = e.clipboardData.getData('text/html');
    const t = e.clipboardData.getData('text/plain');
    if (text.trim() === '' && h) {
      html.current = h;
      pastedText.current = t;
    } else {
      html.current = undefined;
    }
  }

  function onChange(v: string) {
    setText(v);
    if (pastedText.current !== null && v.trim() !== pastedText.current.trim()) html.current = undefined;
  }

  async function submit() {
    setBusy(true);
    try {
      await api.paste(q.id, { text, html: html.current, title: title.trim() || undefined, author: author.trim() || undefined, published: published || undefined });
      toast('Pasted text queued');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="paste-form">
      <p className="paste-hint">
        <a href={q.url} target="_blank" rel="noreferrer">
          Open the page
        </a>
        , select the article (or press ⌘A), copy it and paste it below. Menus and footers are mostly stripped out.
      </p>
      <div className="paste-fields">
        <label className="paste-title">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Article title" />
        </label>
        <label>
          <span>Author</span>
          <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Optional" />
        </label>
        <label>
          <span>Published</span>
          <input type="date" value={published} onChange={(e) => setPublished(e.target.value)} />
        </label>
      </div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        placeholder="Paste the article text here"
        rows={10}
        autoFocus
      />
      <div className="paste-actions">
        <span className="muted">{words > 0 ? `${words.toLocaleString('en-NZ')} words` : ''}</span>
        <button className="btn btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-sm btn-primary" onClick={submit} disabled={busy || words < 30 || !title.trim()}>
          Summarise this text
        </button>
      </div>
    </div>
  );
}

function Setup({ status }: { status: AppStatus }) {
  const steps = [
    {
      ok: status.ytdlp.ok,
      label: 'yt-dlp installed',
      detail: status.ytdlp.ok ? `version ${status.ytdlp.version}` : (status.ytdlp.error || '') + '',
      fix: 'Run `brew install yt-dlp` in Terminal, then reload.',
    },
    { ok: status.apiKey, label: `${status.apiKeyProvider} API key`, detail: status.apiKey ? 'set' : 'not set', fix: 'Add it in Settings.' },
    { ok: !!status.playlistUrl, label: 'Playlist to watch', detail: status.playlistUrl ? 'set' : 'not set', fix: 'Paste the playlist link in Settings.' },
  ];
  if (steps.every((s) => s.ok)) return null;
  return (
    <div className="setup">
      <h2 className="section-h">Setup</h2>
      <ul>
        {steps.map((s) => (
          <li key={s.label} className={s.ok ? 'ok' : 'todo'}>
            <Icon name={s.ok ? 'check' : 'alert'} size={15} />
            <div>
              <strong>{s.label}</strong> <span className="muted">— {s.detail}</span>
              {!s.ok && <div className="setup-fix">{s.fix.split('`').map((p, i) => (i % 2 ? <code key={i}>{p}</code> : p))}</div>}
            </div>
          </li>
        ))}
      </ul>
      <a className="btn btn-sm" href="#/settings">
        Open Settings
      </a>
    </div>
  );
}
