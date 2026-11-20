import type {
  AppConfig,
  AppStatus,
  Connection,
  DuplicateSuggestion,
  GraphData,
  PeopleDates,
  PeopleGraph,
  PersonDates,
  NoteFull,
  NoteSummary,
  QueueItem,
  ShareOptions,
  ShareRecord,
  SearchHit,
  StarredPerson,
  UsageSummary,
  TranscriptSegment,
} from '../../shared/types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data as T;
}

export const api = {
  share: (slug: string) => req<{ configured: boolean; baseUrl: string; share: ShareRecord | null }>('GET', `/api/notes/${encodeURIComponent(slug)}/share`),
  publishShare: (slug: string, options: ShareOptions) => req<ShareRecord>('PUT', `/api/notes/${encodeURIComponent(slug)}/share`, { options }),
  unshare: (slug: string) => req('DELETE', `/api/notes/${encodeURIComponent(slug)}/share`),
  status: () => req<AppStatus>('GET', '/api/status'),
  config: () => req<AppConfig & { apiKeySet: boolean; openaiKeySet: boolean; cloudflareTokenSet: boolean }>('GET', '/api/config'),
  saveConfig: (c: Partial<AppConfig>) => req<AppConfig & { apiKeySet: boolean; openaiKeySet: boolean; cloudflareTokenSet: boolean }>('PUT', '/api/config', c),
  notes: () => req<NoteSummary[]>('GET', '/api/notes'),
  note: (slug: string) => req<NoteFull>('GET', `/api/notes/${encodeURIComponent(slug)}`),
  createNote: (title: string) => req<{ slug: string }>('POST', '/api/notes', { title }),
  updateNote: (
    slug: string,
    patch: { title?: string; tags?: string[]; myTags?: string[]; body?: string; connections?: Connection[]; starred?: boolean; author?: string; speakers?: string },
  ) => req<NoteFull>('PUT', `/api/notes/${encodeURIComponent(slug)}`, patch),
  deleteNote: (slug: string) => req('DELETE', `/api/notes/${encodeURIComponent(slug)}`),
  transcript: (slug: string) => req<{ segments: TranscriptSegment[] }>('GET', `/api/notes/${encodeURIComponent(slug)}/transcript`),
  resummarise: (slug: string) => req('POST', `/api/notes/${encodeURIComponent(slug)}/resummarise`),
  reconnect: (slug: string) => req('POST', `/api/notes/${encodeURIComponent(slug)}/reconnect`),
  search: (q: string) => req<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  tags: () => req<{ tag: string; count: number; mine: boolean }[]>('GET', '/api/tags'),
  graph: () => req<GraphData>('GET', '/api/graph'),
  peopleGraph: () => req<PeopleGraph>('GET', '/api/graph/people'),
  duplicates: () => req<DuplicateSuggestion[]>('GET', '/api/people/duplicates'),
  mergePeople: (alias: string, into: string) => req('POST', '/api/people/merge', { alias, into }),
  unmergePerson: (alias: string) => req('POST', '/api/people/unmerge', { alias }),
  notSame: (a: string, b: string) => req('POST', '/api/people/not-same', { a, b }),
  peopleDates: () => req<PeopleDates>('GET', '/api/people/dates'),
  fillPeopleDates: () => req<PeopleDates>('POST', '/api/people/dates/fill'),
  setPersonDates: (d: { id: string; name: string; born: string; died: string; active: string }) => req<PersonDates>('PUT', '/api/people/dates', d),
  starredPeople: () => req<StarredPerson[]>('GET', '/api/people/starred'),
  starPerson: (name: string, starred: boolean) => req<StarredPerson[]>('PUT', '/api/people/starred', { name, starred }),
  queue: () => req<QueueItem[]>('GET', '/api/queue'),
  addUrl: (url: string) => req<{ exists?: string; item?: QueueItem }>('POST', '/api/queue', { url }),
  retry: (id: string, approve = false) => req('POST', `/api/queue/${encodeURIComponent(id)}/retry`, approve ? { approve } : undefined),
  usage: () => req<UsageSummary>('GET', '/api/usage'),
  maintenance: () => req<{ notes: { slug: string; title: string }[]; estimate: number }>('GET', '/api/maintenance'),
  fixBroken: () => req<{ queued: number }>('POST', '/api/maintenance/resummarise'),
  paste: (id: string, p: { text: string; html?: string; title?: string; author?: string; published?: string }) =>
    req('POST', `/api/queue/${encodeURIComponent(id)}/paste`, p),
  starQueued: (id: string, starred: boolean) => req('PUT', `/api/queue/${encodeURIComponent(id)}/star`, { starred }),
  investQueued: (id: string, invest: boolean) => req('PUT', `/api/queue/${encodeURIComponent(id)}/invest`, { invest }),
  skip: (id: string) => req('POST', `/api/queue/${encodeURIComponent(id)}/skip`),
  clearQueue: () => req('POST', '/api/queue/clear'),
  poll: () => req('POST', '/api/poll'),
};

/** Subscribe to server-sent events; returns an unsubscribe function. */
export function subscribe(handlers: { vault?: (d: { slug: string; kind: string }) => void; queue?: () => void }) {
  const es = new EventSource('/api/events');
  if (handlers.vault) es.addEventListener('vault', (e) => handlers.vault!(JSON.parse((e as MessageEvent).data)));
  if (handlers.queue) es.addEventListener('queue', () => handlers.queue!());
  return () => es.close();
}
