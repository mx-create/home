// RC Standard Finder: Mouser stock proxy for Cloudflare Workers.
// Holds the Mouser API key so it never reaches the browser.
// Secret:  MOUSER_KEY        (Mouser Search API key)
// Variable (optional): ALLOWED_ORIGINS  comma-separated, default https://mxdesign.uk

const json = (body, status, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

const digits = (s) => parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10) || 0;

function slimPart(p) {
  const breaks = Array.isArray(p.PriceBreaks) ? p.PriceBreaks : [];
  const pick = (n) => {
    const b = breaks.filter((x) => Number(x.Quantity) <= n).pop() || breaks[0];
    return b ? { qty: Number(b.Quantity), price: String(b.Price) } : null;
  };
  return {
    mpn: p.ManufacturerPartNumber || '',
    mfr: p.Manufacturer || '',
    mouser: p.MouserPartNumber || '',
    desc: p.Description || '',
    stock: digits(p.AvailabilityInStock) || digits(p.Availability),
    min: Number(p.Min) || 1,
    p1: pick(1),
    p100: breaks.length ? pick(100) : null,
    url: p.ProductDetailUrl || '',
    datasheet: p.DataSheetUrl || '',
    life: p.LifecycleStatus || '',
  };
}

export default {
  async fetch(req, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || 'https://mxdesign.uk').split(',').map((s) => s.trim());
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    if (url.pathname !== '/stock') return json({ error: 'Not found' }, 404, cors);
    if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);
    if (!env.MOUSER_KEY) return json({ error: 'MOUSER_KEY secret is not set' }, 500, cors);

    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
    if (q.length < 3) return json({ error: 'Query too short' }, 400, cors);

    // Cache identical searches for 10 minutes to stay inside Mouser's rate limits.
    const cache = caches.default;
    const key = new Request('https://cache.invalid/stock?q=' + encodeURIComponent(q.toLowerCase()));
    const hit = await cache.match(key);
    if (hit) {
      const r = new Response(hit.body, hit);
      for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
      return r;
    }

    let res;
    try {
      res = await fetch('https://api.mouser.com/api/v1/search/keyword?apiKey=' + encodeURIComponent(env.MOUSER_KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          SearchByKeywordRequest: { keyword: q, records: 25, startingRecord: 0, searchOptions: 'InStock' },
        }),
      });
    } catch (e) {
      return json({ error: 'Could not reach Mouser' }, 502, cors);
    }
    if (res.status === 429) return json({ error: 'Mouser rate limit reached. Try again in a minute' }, 429, cors);
    let data;
    try { data = await res.json(); } catch (e) { return json({ error: 'Unreadable reply from Mouser' }, 502, cors); }
    if (!res.ok || (Array.isArray(data.Errors) && data.Errors.length)) {
      const msg = (data.Errors && data.Errors[0] && data.Errors[0].Message) || 'Mouser returned an error';
      return json({ error: msg }, 502, cors);
    }

    const parts = ((data.SearchResults && data.SearchResults.Parts) || [])
      .map(slimPart)
      .filter((p) => p.mpn && p.stock > 0);
    const out = json({ query: q, total: (data.SearchResults && data.SearchResults.NumberOfResult) || parts.length, parts }, 200, {
      ...cors,
      'Cache-Control': 'public, max-age=600',
    });
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  },
};
