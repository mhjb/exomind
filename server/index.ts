import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { DATA_DIR, ROOT, getConfig, publicConfig, saveConfig } from './config.ts';
import {
  allEntries,
  deleteNote,
  allTags,
  myTagSet,
  fullNote,
  getEntry,
  loadVault,
  readTranscript,
  summaries,
  uniqueSlug,
  vaultEvents,
  writeNote,
} from './vault.ts';
import {
  addNoteJob,
  addUrl,
  clearFinished,
  kick,
  loadState,
  pipelineEvents,
  pollInfo,
  pollNow,
  brokenReport,
  resummariseBroken,
  queueSnapshot,
  restartPoller,
  starItem,
  retry,
  skip,
  pasteArticle,
} from './pipeline.ts';
import { search } from './search.ts';
import { ytdlpVersion } from './youtube.ts';
import { providerOf } from './models.ts';
import { budgetState, costForSlug, summary as usageSummary } from './usage.ts';
import { parseTranscriptMarkdown } from './transcript.ts';
import { noteSpeakers, peopleGraph, setSpeakers, syncPeopleFromBody } from './people.ts';
import { renameStarred, setStarred, starredPeople } from './starredPeople.ts';
import { fillPeopleDates, peopleDates, setPersonDates } from './lifespans.ts';
import { getShare, publishShare, shareConfigured, unpublishShare } from './share.ts';
import { duplicateSuggestions, markNotSame, mergePeople, unmergePerson } from './merges.ts';
import type { AppConfig, AppStatus, Connection, GraphData, NoteMeta } from '../shared/types.ts';

const PORT = Number(process.env.EXO_PORT || 4747);

/** Is there a key for every provider the configured models need? */
function keyStatus() {
  const cfg = getConfig();
  const needed = new Set([providerOf(cfg.model), providerOf(cfg.connectModel || cfg.model)]);
  const missing = [...needed].filter((p) => !(p === 'openai' ? cfg.openaiApiKey : cfg.anthropicApiKey));
  const names = { openai: 'OpenAI', anthropic: 'Anthropic' } as const;
  return { apiKey: missing.length === 0, apiKeyProvider: (missing.length ? missing : [...needed]).map((p) => names[p]).join(' + ') };
}
const app = express();
app.use(express.json({ limit: '10mb' }));

const wrap =
  (fn: (req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  };

// ---------- status & config ----------

let ytdlpCache: { at: number; v: AppStatus['ytdlp'] } | null = null;
async function ytdlpStatus(force = false) {
  if (!force && ytdlpCache && Date.now() - ytdlpCache.at < 60_000) return ytdlpCache.v;
  const v = await ytdlpVersion();
  ytdlpCache = { at: Date.now(), v };
  return v;
}

app.get(
  '/api/status',
  wrap(async (): Promise<AppStatus> => {
    const cfg = getConfig();
    return {
      ytdlp: await ytdlpStatus(),
      ...keyStatus(),
      playlistUrl: cfg.playlistUrl,
      autoPoll: cfg.autoPoll,
      paused: cfg.paused,
      noteCount: allEntries().length,
      vaultPath: cfg.vaultPath,
      monthSpend: budgetState().spent,
      budget: budgetState().budget,
      overBudget: budgetState().over,
      ...pollInfo(),
    };
  }),
);

app.get('/api/config', wrap(() => publicConfig()));

app.put(
  '/api/config',
  wrap(async (req) => {
    const patch = { ...(req.body as Partial<AppConfig>) };
    if (patch.anthropicApiKey && patch.anthropicApiKey.includes('…')) delete patch.anthropicApiKey; // masked value sent back
    if (patch.openaiApiKey && patch.openaiApiKey.includes('…')) delete patch.openaiApiKey;
    if (patch.cloudflareApiToken && patch.cloudflareApiToken.includes('…')) delete patch.cloudflareApiToken;
    delete (patch as Record<string, unknown>).cloudflareTokenSet;
    const before = getConfig();
    const cfg = saveConfig(patch);
    if (cfg.vaultPath !== before.vaultPath) {
      loadVault();
      loadState();
    }
    if (cfg.ytdlpPath !== before.ytdlpPath || cfg.cookiesFromBrowser !== before.cookiesFromBrowser) await ytdlpStatus(true);
    restartPoller();
    kick();
    return publicConfig();
  }),
);

// ---------- notes ----------

app.get('/api/notes', wrap(() => summaries()));

app.post(
  '/api/notes',
  wrap((req) => {
    const title = String(req.body?.title || 'Untitled note').trim();
    const slug = uniqueSlug(title);
    const meta: NoteMeta = { id: slug, type: 'manual', title, added: new Date().toISOString(), tags: [], connections: [] };
    writeNote(slug, meta, `# ${title}\n\n## My notes\n\n`);
    return { slug };
  }),
);

app.get(
  '/api/notes/:slug',
  wrap((req, res) => {
    const n = fullNote(String(req.params.slug));
    if (!n) return res.status(404).json({ error: 'Not found' });
    return { ...n, speakers: noteSpeakers(n.meta, n.body), cost: costForSlug(n.slug) };
  }),
);

app.put(
  '/api/notes/:slug',
  wrap((req, res) => {
    const slug = String(req.params.slug);
    const e = getEntry(slug);
    if (!e) return res.status(404).json({ error: 'Not found' });
    const b = req.body as { title?: string; tags?: string[]; myTags?: string[]; body?: string; connections?: Connection[]; starred?: boolean; gist?: string; author?: string; speakers?: string };
    let meta: NoteMeta = { ...e.meta };
    if (typeof b.title === 'string' && b.title.trim()) meta.title = b.title.trim();
    if (Array.isArray(b.tags)) meta.tags = [...new Set(b.tags.map((t) => t.trim()).filter(Boolean))];
    // Tags added by hand. One that the model had already given the note becomes yours (it moves across).
    if (Array.isArray(b.myTags)) {
      const mine = [...new Set(b.myTags.map((t) => t.trim()).filter(Boolean))];
      meta.my_tags = mine.length ? mine : undefined;
      meta.tags = meta.tags.filter((t) => !mine.includes(t));
    }
    if (typeof b.gist === 'string') meta.gist = b.gist;
    if (typeof b.starred === 'boolean') meta.starred = b.starred;
    if (Array.isArray(b.connections))
      meta.connections = b.connections
        .filter((c) => c.target && c.target !== slug)
        .map((c) => ({ target: c.target, reason: c.reason || '', strength: c.strength, manual: c.manual || undefined }));
    let body = typeof b.body === 'string' ? b.body : e.body;
    let renamed: { from: string; to: string } | undefined;
    // People or works typed into the note's "People & works" lines reach the people graph and side panel.
    if (typeof b.body === 'string') ({ meta, body, renamed } = syncPeopleFromBody(meta, e.body, body));
    // Keep the body's H1 in step with a renamed title.
    if (meta.title !== e.meta.title) body = body.replace(/^# .*$/m, `# ${meta.title}`);
    // Corrected speakers (an article's author) also update the people list and attributions the people graph reads.
    const who = typeof b.speakers === 'string' ? b.speakers : b.author;
    if (typeof who === 'string') ({ meta, body, renamed } = setSpeakers(meta, body, who));
    writeNote(slug, meta, body);
    if (renamed) renameStarred(renamed.from, renamed.to);
    const n = fullNote(slug)!;
    return { ...n, speakers: noteSpeakers(n.meta, n.body), cost: costForSlug(slug) };
  }),
);

app.delete(
  '/api/notes/:slug',
  wrap((req) => ({ ok: deleteNote(String(req.params.slug)) })),
);

app.get(
  '/api/notes/:slug/transcript',
  wrap((req, res) => {
    const slug = String(req.params.slug);
    const e = getEntry(slug);
    if (!e) return res.status(404).json({ error: 'Not found' });
    const md = readTranscript(e.meta, slug);
    return { segments: md ? parseTranscriptMarkdown(md) : [] };
  }),
);

app.post('/api/notes/:slug/resummarise', wrap((req) => addNoteJob('resummarise', String(req.params.slug))));
app.post('/api/notes/:slug/reconnect', wrap((req) => addNoteJob('reconnect', String(req.params.slug))));

// ---------- browse ----------

app.get('/api/search', wrap((req) => search(String(req.query.q || ''))));

app.get(
  '/api/tags',
  wrap(() => {
    const counts = new Map<string, number>();
    for (const e of allEntries()) for (const t of allTags(e.meta)) counts.set(t, (counts.get(t) || 0) + 1);
    const mine = myTagSet();
    // Your own tags first, then the model's, each by how often they're used.
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count, mine: mine.has(tag) }))
      .sort((a, b) => Number(b.mine) - Number(a.mine) || b.count - a.count || a.tag.localeCompare(b.tag));
  }),
);

app.get('/api/graph/people', wrap(() => peopleGraph()));

app.get('/api/people/duplicates', wrap(() => duplicateSuggestions()));
app.post('/api/people/merge', wrap((req) => mergePeople(String(req.body?.alias || ''), String(req.body?.into || ''))));
app.post('/api/people/unmerge', wrap((req) => unmergePerson(String(req.body?.alias || ''))));
app.post('/api/people/not-same', wrap((req) => markNotSame(String(req.body?.a || ''), String(req.body?.b || ''))));
app.get('/api/people/dates', wrap(() => peopleDates()));
app.post('/api/people/dates/fill', wrap(() => fillPeopleDates()));
app.put(
  '/api/people/dates',
  wrap((req) => {
    const b = req.body as { id?: string; name?: string; born?: string; died?: string; active?: string };
    return setPersonDates(String(b?.id || ''), String(b?.name || ''), b || {});
  }),
);

app.get('/api/people/starred', wrap(() => starredPeople()));
app.put(
  '/api/people/starred',
  wrap((req) => {
    const b = req.body as { name?: string; starred?: boolean };
    return setStarred(String(b?.name || ''), b?.starred !== false);
  }),
);

app.get(
  '/api/graph',
  wrap((): GraphData => {
    const entries = allEntries();
    const ids = new Set(entries.map((e) => e.slug));
    const links: GraphData['links'] = [];
    const seen = new Set<string>();
    const degree = new Map<string, number>();
    for (const e of entries)
      for (const c of e.meta.connections) {
        if (!ids.has(c.target)) continue;
        const key = [e.slug, c.target].sort().join('→');
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: e.slug, target: c.target, strength: c.strength || 2 });
        degree.set(e.slug, (degree.get(e.slug) || 0) + 1);
        degree.set(c.target, (degree.get(c.target) || 0) + 1);
      }
    return { nodes: entries.map((e) => ({ id: e.slug, title: e.meta.title, tags: allTags(e.meta), degree: degree.get(e.slug) || 0 })), links };
  }),
);

// ---------- queue ----------

app.get('/api/queue', wrap(() => queueSnapshot()));
app.post(
  '/api/queue',
  wrap((req) => {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//.test(url)) throw new Error('Paste a full link starting with https://');
    return addUrl(url);
  }),
);
app.post('/api/queue/clear', wrap(() => (clearFinished(), { ok: true })));
app.post('/api/queue/:id/retry', wrap((req) => (retry(String(req.params.id), !!req.body?.approve), { ok: true })));

app.get('/api/maintenance', wrap(() => brokenReport()));
app.post('/api/maintenance/resummarise', wrap(() => ({ queued: resummariseBroken() })));

app.get('/api/usage', wrap(() => usageSummary(new Map(allEntries().map((e) => [e.slug, e.meta.title])))));
app.post(
  '/api/queue/:id/paste',
  wrap((req) => {
    const b = req.body || {};
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    pasteArticle(String(req.params.id), { text: str(b.text) || '', html: str(b.html), title: str(b.title), author: str(b.author), published: str(b.published) });
    return { ok: true };
  }),
);
app.put('/api/queue/:id/star', wrap((req) => (starItem(String(req.params.id), req.body?.starred !== false), { ok: true })));
app.put('/api/queue/:id/invest', wrap((req) => (starItem(String(req.params.id), req.body?.invest !== false, 'invest'), { ok: true })));
app.post('/api/queue/:id/skip', wrap((req) => (skip(String(req.params.id)), { ok: true })));
app.post(
  '/api/poll',
  wrap(async () => {
    await pollNow();
    return { ok: true };
  }),
);

// ---------- live updates (server-sent events) ----------

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const onVault = (d: unknown) => send('vault', d);
  const onQueue = () => send('queue', pollInfo());
  vaultEvents.on('change', onVault);
  pipelineEvents.on('queue', onQueue);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    vaultEvents.off('change', onVault);
    pipelineEvents.off('queue', onQueue);
  });
});

// ---------- sharing ----------

app.get(
  '/api/notes/:slug/share',
  wrap((req) => ({ configured: shareConfigured(), baseUrl: getConfig().shareBaseUrl, share: getShare(String(req.params.slug)) })),
);
app.put('/api/notes/:slug/share', wrap((req) => publishShare(String(req.params.slug), req.body?.options || {})));
app.delete('/api/notes/:slug/share', wrap(async (req) => (await unpublishShare(String(req.params.slug)), { ok: true })));

// ---------- web UI ----------

// In dev (EXO_DEV=1, set by `npm run dev`) Vite runs inside this server, so the live
// source is served on the same port with hot reload. Otherwise serve the built dist/.
const DEV = process.env.EXO_DEV === '1';
const httpServer = http.createServer(app);
if (DEV) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  // The Mac app ships the built UI beside the bundled server and says where (EXO_DIST).
  const dist = process.env.EXO_DIST || path.join(ROOT, 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    app.get(/^(?!\/api).*/, (_req, res) =>
      res.status(503).send('No built UI in dist/. Run `npm start` (builds first) or `npm run dev`.'),
    );
  }
}

// ---------- start ----------

loadVault();
loadState();
restartPoller();
kick();

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Exo-mind running at http://localhost:${PORT}${DEV ? ' (dev, hot reload)' : ''}`);
  console.log(`  data: ${DATA_DIR}\n  vault: ${getConfig().vaultPath}\n`);
});
