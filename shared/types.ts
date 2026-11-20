// Types shared between the server and the web UI.

export interface Connection {
  target: string; // slug of the connected note
  reason: string; // one line on why these connect
  strength?: number; // 1 (tangential) – 3 (strong)
  manual?: boolean; // added by hand rather than by Claude
}

/** The personal tag that replaced the old investment flag: worth weighing when buying or selling shares. */
export const INVEST_TAG = 'investment';

export interface NoteMeta {
  id: string; // YouTube video id, an article's normalised URL, or other source id
  type: 'youtube' | 'video' | 'article' | 'manual';
  title: string;
  url?: string;
  channel?: string; // YouTube channel, or an article's publication/site
  channel_url?: string;
  author?: string; // articles
  published?: string; // YYYY-MM-DD
  added: string; // ISO timestamp
  duration?: number; // seconds
  words?: number; // articles: length of the text
  thumbnail?: string;
  tags: string[]; // the model's tags (re-summarising adds to these)
  my_tags?: string[]; // tags added by hand ("inspiring"): never touched by the model, listed first
  people?: string[];
  speakers?: string[]; // people who appear in the source itself (host, guest, lecturer); a subset of people
  speakers_edited?: boolean; // speakers were set by hand: don't infer more from quotes or the title
  works?: string[];
  gist?: string;
  transcript?: string; // relative path to transcript file
  transcript_source?: 'manual' | 'auto' | 'none' | 'article';
  archived?: string; // articles: Wayback Machine snapshot the text came from, when the site blocked us
  archived_date?: string; // YYYY-MM-DD of that snapshot
  pasted?: boolean; // articles: the text was pasted in by hand because the page couldn't be fetched
  model?: string;
  connections: Connection[];
  starred?: boolean;
  invest?: boolean; // legacy: the old investment flag, now the personal tag "investment" (moved across on load)
}

export interface NoteSummary {
  slug: string;
  type: NoteMeta['type'];
  title: string;
  channel?: string;
  author?: string;
  words?: number;
  gist?: string;
  tags: string[]; // every tag, the note's own (by hand) first, then the model's
  myTags: string[]; // the ones added by hand
  added: string;
  published?: string;
  duration?: number;
  thumbnail?: string;
  starred?: boolean;
  links: number; // outgoing + incoming
}

export interface Backlink {
  slug: string;
  title: string;
  reason: string;
  strength?: number;
}

export interface ResolvedConnection extends Connection {
  title: string;
  exists: boolean;
}

export interface NoteFull {
  slug: string;
  meta: NoteMeta;
  body: string; // markdown body without the generated connections section
  connections: ResolvedConnection[];
  backlinks: Backlink[];
  speakers?: string[]; // who the people graph counts as speaking (explicit or inferred)
  cost?: { cost: number; input: number; output: number; calls: number } | null;
}

export interface TranscriptSegment {
  t: number; // seconds (videos) or paragraph number (articles)
  text: string;
}

export type JobKind = 'ingest' | 'resummarise' | 'reconnect';
export type JobStatus = 'queued' | 'processing' | 'done' | 'error' | 'skipped';

export interface QueueItem {
  id: string; // video id, or `${kind}:${slug}` for note jobs
  kind: JobKind;
  url?: string;
  slug?: string;
  title?: string;
  status: JobStatus;
  step?: string;
  error?: string;
  source: 'playlist' | 'manual' | 'app';
  queuedAt: string;
  finishedAt?: string;
  attempts?: number; // automatic retries after YouTube rate limits
  retryAt?: string; // don't start before this time
  estimate?: number; // estimated Claude cost (USD) before summarising
  needsApproval?: boolean; // held back by the per-video cost limit
  approved?: boolean; // user OK'd running it despite the limit
  starred?: boolean; // starred while queued: the note is starred when it's written
  invest?: boolean; // flagged for investing while queued, the same way
}

export interface AppConfig {
  playlistUrl: string;
  pollMinutes: number;
  autoPoll: boolean;
  paused: boolean;
  vaultPath: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  model: string; // used for summaries; provider is inferred from the name (claude-* or gpt-*)
  connectModel: string; // model for finding connections; blank = same as model
  reasoningEffort: 'none' | 'low' | 'medium' | 'high'; // OpenAI reasoning models only
  ytdlpPath: string;
  cookiesFromBrowser: string; // e.g. "chrome", "safari", "firefox" — blank for none
  subLangs: string;
  aboutMe: string; // optional context to tailor summaries
  monthlyBudgetUsd: number; // 0 = no limit; processing pauses when reached
  maxCostPerItemUsd: number; // 0 = no limit; items estimated above this wait for approval
  // Sharing single notes as public read-only pages (Cloudflare Pages + KV). Blank = sharing off.
  cloudflareAccountId: string;
  cloudflareKvNamespaceId: string;
  cloudflareApiToken: string;
  shareBaseUrl: string; // e.g. https://notes.example.com
}

export interface AppStatus {
  ytdlp: { ok: boolean; version?: string; error?: string };
  apiKey: boolean; // key present for the provider of the configured model(s)
  apiKeyProvider: string;
  playlistUrl: string;
  autoPoll: boolean;
  paused: boolean;
  lastPoll?: string;
  lastPollError?: string;
  nextPoll?: string;
  polling: boolean;
  noteCount: number;
  vaultPath: string;
  working?: string;
  monthSpend: number;
  budget: number;
  overBudget: boolean;
  youtubeWaitUntil?: string;
}

export interface SearchHit {
  slug: string;
  title: string;
  channel?: string;
  score: number;
  snippet: string;
  where: 'note' | 'transcript';
  t?: number;
  article?: boolean; // t is a paragraph number, not seconds
}

export interface GraphData {
  nodes: { id: string; title: string; tags: string[]; degree: number }[];
  links: { source: string; target: string; strength: number }[];
}

/** People named across the library, and the notes they appear in or are mentioned in. */
export interface PeopleGraph {
  notes: { id: string; title: string; channel?: string }[];
  people: { id: string; name: string; appears: string[]; mentioned: string[] }[];
  aliases?: Record<string, string[]>; // person id → the other names merged into them
  aliasOf?: Record<string, string>; // merged-away name's key → the person id it now belongs to
}

/** Two people who are probably one person, for you to confirm. */
export interface DuplicateSuggestion {
  keep: { id: string; name: string; notes: number; dates?: PersonDates };
  merge: { id: string; name: string; notes: number; dates?: PersonDates };
  reason: 'name' | 'dates'; // one name is the other with words left out, or they share firm dates
}

/** When someone lived. Years are integers, BC negative (no year 0). */
export interface PersonDates {
  name: string;
  born?: number | null;
  died?: number | null;
  living?: boolean;
  active?: number | null; // the year they're placed at: roughly mid-career, or a traditional date
  confidence: 'high' | 'medium' | 'low' | 'none'; // none: not a person who can be placed in time
  edited?: boolean; // corrected by hand: never overwritten
}

export interface PeopleDates {
  dates: Record<string, PersonDates>; // by people graph person id
  job: { running: boolean; done: number; total: number; error?: string };
  missing: number; // people in the graph with no dates yet
}

/** Someone starred as worth paying attention to, and the notes they're in. */
export interface StarredPerson {
  name: string;
  key: string; // matching key (see shared/names.ts)
  appears: string[]; // slugs of notes they speak in (or wrote)
  mentioned: string[]; // slugs of notes that only mention them
}

export interface UsageRecord {
  at: string;
  model: string;
  kind: 'summary' | 'summary-part' | 'connections' | 'people-dates';
  slug?: string;
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  reasoning?: number; // OpenAI reasoning tokens (already included in output)
  cost: number | null; // USD; null if the model's price is unknown
}

export interface UsageSummary {
  today: number;
  month: number;
  allTime: number;
  avgPerNote: number;
  budget: number;
  maxPerItem: number;
  days: { day: string; cost: number; calls: number }[];
  months: { month: string; cost: number }[];
  notes: { slug: string; title: string; deleted: boolean; cost: number; input: number; output: number; calls: number; last: string }[];
  calls: number;
  unpriced: number;
  models: string[];
  prices: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>;
}

// ---------- sharing ----------

/** What a shared page shows besides the summary itself. */
export interface ShareOptions {
  peopleGraph: boolean;
  otherNotes: boolean; // titles of your other notes: connections, and where people come up elsewhere
  tags: boolean;
  works: boolean;
  transcript: boolean;
  myNotes: boolean; // your own "My notes" section
}

export const DEFAULT_SHARE_OPTIONS: ShareOptions = { peopleGraph: true, otherNotes: false, tags: true, works: true, transcript: false, myNotes: false };

/** A published note on this machine: where it lives and what was chosen. */
export interface ShareRecord {
  id: string;
  url: string;
  options: ShareOptions;
  sharedAt: string; // ISO, last published
}

/** One line of the public index of shared notes (stored in KV under INDEX_KEY). */
export interface ShareIndexEntry {
  id: string;
  title: string;
  type: NoteMeta['type'];
  channel?: string;
  speakers: string[];
  thumbnail?: string;
  published?: string;
  duration?: number;
  gist?: string;
  sharedAt: string;
}

export const SHARE_INDEX_KEY = 'index:v1'; // not a valid share id, so it can't be opened as one

/** Everything a shared page needs, stored as one JSON value in KV. Contains only what was chosen. */
export interface ShareSnapshot {
  v: 1;
  id: string;
  sharedAt: string;
  options: ShareOptions;
  meta: Pick<NoteMeta, 'type' | 'title' | 'url' | 'channel' | 'channel_url' | 'author' | 'published' | 'duration' | 'words' | 'thumbnail' | 'transcript_source' | 'people'>;
  speakers: string[];
  body: string; // markdown, title removed, links to other notes flattened to text
  tags?: string[];
  works?: string[];
  connections?: { title: string; reason: string; strength?: number }[];
  library?: PeopleGraph; // trimmed to the people in this note
  dates?: Record<string, PersonDates>;
  transcript?: TranscriptSegment[];
}
