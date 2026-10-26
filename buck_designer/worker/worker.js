// Mouser part lookup proxy for Buck Designer (Cloudflare Worker)
// Keeps the Mouser API key on the server and returns clean JSON to the tool.
//
// Setup:
//   1. Cloudflare dashboard → Workers & Pages → Create → Worker → paste this file → Deploy
//   2. Worker → Settings → Variables and Secrets → add Secret  MOUSER_KEY = <your Mouser Search API key>
//   3. Test: https://<your-worker>.workers.dev/part?pn=BSC0902NS
//
// Usage from the page:  GET /part?pn=<part number>

const ALLOWED_ORIGINS = [
  "https://mxdesign.uk",
  "https://www.mxdesign.uk",
  "http://localhost:8000", // local testing; remove when live
];

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== "/part") return json({ error: "Use /part?pn=..." }, 404, cors);

    const pn = (url.searchParams.get("pn") || "").trim();
    if (!/^[A-Za-z0-9.\-\/#+_ ]{2,60}$/.test(pn)) return json({ error: "Invalid part number" }, 400, cors);
    if (!env.MOUSER_KEY) return json({ error: "MOUSER_KEY secret not set" }, 500, cors);

    // Cache each part for 24 h so repeat lookups don't spend API calls
    const cache = caches.default;
    const cacheKey = new Request(`https://cache.local/part/${encodeURIComponent(pn.toUpperCase())}`);
    const hit = await cache.match(cacheKey);
    if (hit) return withCors(hit, cors);

    const res = await fetch(
      `https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(env.MOUSER_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          SearchByPartRequest: { mouserPartNumber: pn, partSearchOptions: "Exact" },
        }),
      }
    );
    if (!res.ok) return json({ error: `Mouser returned ${res.status}` }, 502, cors);

    const data = await res.json();
    if (data.Errors && data.Errors.length) {
      return json({ error: data.Errors.map(e => e.Message).join("; ") }, 502, cors);
    }

    const parts = (data.SearchResults && data.SearchResults.Parts) || [];
    // Prefer an exact manufacturer part number match
    const p =
      parts.find(x => (x.ManufacturerPartNumber || "").toUpperCase() === pn.toUpperCase()) ||
      parts[0];

    const out = p
      ? {
          found: true,
          query: pn,
          mpn: p.ManufacturerPartNumber,
          manufacturer: p.Manufacturer,
          description: p.Description,
          category: p.Category,
          datasheet: p.DataSheetUrl || null,
          productUrl: p.ProductDetailUrl || null,
          stock: p.AvailabilityInStock ?? p.Availability ?? null,
          lifecycle: p.LifecycleStatus || null,
          attributes: Object.fromEntries(
            (p.ProductAttributes || []).map(a => [a.AttributeName, a.AttributeValue])
          ),
          priceBreaks: (p.PriceBreaks || []).map(b => ({ qty: b.Quantity, price: b.Price, currency: b.Currency })),
          otherMatches: parts.length - 1,
        }
      : { found: false, query: pn };

    const response = json(out, 200, { "Cache-Control": "public, max-age=86400" });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return withCors(response, cors);
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function withCors(response, cors) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
  return r;
}
