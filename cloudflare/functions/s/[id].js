// GET /s/<id>: the viewer page with that note's snapshot (from KV) inlined, plus link-preview tags.
// Unknown ids get the same page without a snapshot, which shows "Nothing here".

const escAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export async function onRequestGet({ params, env, request }) {
  const id = String(params.id || '');
  const raw = /^[A-Za-z0-9_-]{6,40}$/.test(id) ? await env.SHARES.get(id) : null;
  const page = await env.ASSETS.fetch(new URL('/', request.url));
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': raw ? 'public, max-age=60' : 'no-store' };
  if (!raw) return new Response(page.body, { status: 404, headers });

  let snap;
  try {
    snap = JSON.parse(raw);
  } catch {
    return new Response(page.body, { status: 500, headers });
  }
  const m = snap.meta || {};
  const by = [snap.speakers?.join(', '), m.channel].filter(Boolean).join(' · ');
  const meta = [
    ['og:title', m.title],
    ['og:description', by],
    ['og:type', 'article'],
    ['og:url', request.url],
    ['og:image', m.thumbnail],
    ['twitter:card', m.thumbnail ? 'summary_large_image' : 'summary'],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<meta property="${k}" content="${escAttr(v)}">`)
    .join('');
  // Inline JSON: escape "<" so the text can never close the script tag.
  const data = `<script id="snapshot" type="application/json">${raw.replace(/</g, '\\u003c')}</script>`;

  return new HTMLRewriter()
    .on('title', { element: (e) => e.setInnerContent(m.title || 'Exo-mind') })
    .on('head', { element: (e) => e.append(meta, { html: true }) })
    .on('body', { element: (e) => e.prepend(data, { html: true }) })
    .transform(new Response(page.body, { headers }));
}
