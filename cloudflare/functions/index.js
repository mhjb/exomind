// GET /: the list of everything shared, inlined into the viewer page.
export async function onRequestGet({ env, request }) {
  const raw = (await env.SHARES.get('index:v1')) || '[]';
  const page = await env.ASSETS.fetch(new URL('/', request.url));
  const data = `<script id="share-index" type="application/json">${raw.replace(/</g, '\\u003c')}</script>`;
  return new HTMLRewriter()
    .on('title', { element: (e) => e.setInnerContent('Shared notes · Exo-mind') })
    .on('body', { element: (e) => e.prepend(data, { html: true }) })
    .transform(new Response(page.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } }));
}
