// Mouser part lookup proxy for Buck Designer (Cloudflare Worker)
// Keeps the Mouser API key on the server and returns clean JSON to the tool.
//
// Also hosts the shared parts library (routes under /lib) stored in a KV namespace bound as PARTS.
//
// Setup:
//   0. Shared library: Workers & Pages → KV → Create namespace "mx-parts", then
//      Worker → Settings → Bindings → Add → KV namespace → variable name PARTS → pick mx-parts
//   1. Cloudflare dashboard → Workers & Pages → Create → Worker → paste this file → Deploy
//   2. Worker → Settings → Variables and Secrets → add Secret  MOUSER_KEY = <your Mouser Search API key>
//   2b. Add Secret LOOKUP_PASS = the password that unlocks Mouser lookups (only you should know it)
//   2c. DigiKey (optional): Secrets DIGIKEY_ID and DIGIKEY_SECRET from developer.digikey.com (Product Information V4 app)
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
      "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Access-Control-Allow-Headers": "Content-Type, X-Lookup-Key",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (url.pathname.startsWith("/lib")) return handleLib(request, env, url, cors, origin);
    if (url.pathname === "/lookup-check" || url.pathname === "/part" || url.pathname === "/digikey") {
      // Mouser lookups use the shared API key, so only the owner (who knows LOOKUP_PASS) may trigger them
      if (!env.LOOKUP_PASS) return json({ error: "LOOKUP_PASS secret not set" }, 500, cors);
      if (!safeEq(request.headers.get("X-Lookup-Key") || "", env.LOOKUP_PASS)) return json({ error: "Lookup password needed" }, 401, cors);
      if (url.pathname === "/lookup-check") return json({ ok: true }, 200, cors);
    }
    if (url.pathname === "/digikey") return handleDigikey(url, env, cors);
    if (url.pathname !== "/part") return json({ error: "Use /part?pn=... or /lib" }, 404, cors);

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

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

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


/* ===================== Shared parts library (KV) =====================
   Key  p:<type>:<PN>            current entry (JSON), metadata = compact copy for listing
   Key  h:<type>:<PN>:<time>     previous versions, kept 90 days (recover from edits or deletes)
   Routes
     GET    /lib                          all parts, grouped by type
     GET    /lib/part?type=&pn=           one full entry
     PUT    /lib/part                     {type, pn, entry:{...}, by}  create or merge into an existing entry
     DELETE /lib/part?type=&pn=           remove (previous version kept in history)
     GET    /lib/history?type=&pn=        earlier versions                                                  */
const LIB_TYPES = ["cap", "ctrl", "conv", "fet", "ind"];
const PN_RE = /^[A-Za-z0-9.\-\/#+_ ]{2,60}$/;
const HIST_TTL = 60 * 60 * 24 * 90;

async function handleLib(request, env, url, cors, origin) {
  if (!env.PARTS) return json({ error: "Library storage not set up" }, 503, cors);
  const path = url.pathname.replace(/\/+$/, "");
  const write = request.method === "PUT" || request.method === "DELETE";
  if (write && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Writes are only accepted from the MX tools" }, 403, cors);
  const noStore = { ...cors, "Cache-Control": "no-store" };
  try {
    if (path === "/lib" && request.method === "GET") return json(await listAll(env), 200, noStore);

    if (path === "/lib/part" || path === "/lib/history") {
      let type, pn, body = null;
      if (request.method === "PUT") {
        if (+request.headers.get("Content-Length") > 8192) return json({ error: "Entry too large" }, 413, cors);
        body = await request.json().catch(() => null);
        if (!body) return json({ error: "Invalid JSON" }, 400, cors);
        type = body.type; pn = body.pn;
      } else { type = url.searchParams.get("type"); pn = url.searchParams.get("pn"); }
      pn = String(pn || "").trim();
      if (!LIB_TYPES.includes(type)) return json({ error: "Unknown part type" }, 400, cors);
      if (!PN_RE.test(pn)) return json({ error: "Invalid part number" }, 400, cors);
      const key = `p:${type}:${pn.toUpperCase()}`;

      if (path === "/lib/history" && request.method === "GET") {
        const l = await env.PARTS.list({ prefix: `h:${type}:${pn.toUpperCase()}:` });
        const items = await Promise.all(l.keys.slice(-20).map(async k => ({ time: +k.name.split(":").pop(), entry: await env.PARTS.get(k.name, "json") })));
        return json({ history: items.sort((a, b) => b.time - a.time) }, 200, noStore);
      }
      if (request.method === "GET") {
        const e = await env.PARTS.get(key, "json");
        return e ? json(e, 200, noStore) : json({ error: "Not found" }, 404, cors);
      }
      const old = await env.PARTS.get(key, "json");
      if (request.method === "DELETE") {
        if (!old) return json({ error: "Not found" }, 404, cors);
        await archive(env, type, pn, old);
        await env.PARTS.delete(key);
        return json({ ok: true }, 200, noStore);
      }
      if (request.method === "PUT") {
        const entry = cleanEntry(type, pn, body.entry, body.by, old);
        if (typeof entry === "string") return json({ error: entry }, 400, cors);
        if (old) await archive(env, type, pn, old);
        await env.PARTS.put(key, JSON.stringify(entry), { metadata: compact(entry) });
        return json(entry, 200, noStore);
      }
    }
  } catch (e) {
    return json({ error: "Library error" }, 500, cors);
  }
  return json({ error: "Not found" }, 404, cors);
}

async function archive(env, type, pn, entry) {
  await env.PARTS.put(`h:${type}:${pn.toUpperCase()}:${Date.now()}`, JSON.stringify(entry), { expirationTtl: HIST_TTL });
}

const str = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n) : "");

/* validate and merge: numbers only in vals, text fields length-limited, existing values kept unless replaced */
function cleanEntry(type, pn, e, by, old) {
  if (!e || typeof e !== "object") return "Missing entry";
  const out = Object.assign({}, old || {});
  out.pn = pn.toUpperCase();
  for (const [k, n] of [["manufacturer", 80], ["description", 300], ["dielectric", 8]]) {
    const v = str(e[k], n); if (v) out[k] = v;
  }
  const ds = str(e.datasheet, 400);
  if (ds) { if (!/^https?:\/\//i.test(ds)) return "Datasheet must be a web link"; out.datasheet = ds; }
  if (type === "cap") {
    const t = str(e.type, 8);
    if (t) { if (!["mlcc", "poly", "tant", "alu", "film"].includes(t)) return "Unknown capacitor type"; out.type = t; }
  }
  if (typeof e.verified === "boolean") {
    if (e.verified !== !!(old && old.verified === true)) out.verifiedAt = new Date().toISOString();
    out.verified = e.verified;
  } else if (typeof out.verified !== "boolean") out.verified = false;
  const vals = Object.assign({}, (old && old.vals) || {});
  if (e.vals && typeof e.vals === "object") {
    for (const [k, v] of Object.entries(e.vals)) {
      if (!/^[A-Za-z0-9_]{1,16}$/.test(k)) return "Bad value name";
      if (typeof v !== "number" || !isFinite(v) || Math.abs(v) > 1e12) return `Value ${k} must be a number`;
      vals[k] = v;
    }
  }
  if (Object.keys(vals).length > 48) return "Too many values";
  if (!Object.keys(vals).length) return "An entry needs at least one value";
  out.vals = vals;
  out.by = str(by, 40) || "anonymous";
  out.at = new Date().toISOString();
  return out;
}

/* KV metadata is limited to 1 KB: keep what the picker needs, drop long text first */
function compact(e) {
  const m = { pn: e.pn, type: e.type, dielectric: e.dielectric, manufacturer: e.manufacturer, datasheet: e.datasheet, description: e.description, vals: e.vals, verified: e.verified === true, by: e.by, at: e.at };
  for (const drop of [null, "description", "datasheet", "manufacturer"]) {
    if (drop) delete m[drop];
    if (JSON.stringify(m).length <= 950) return m;
  }
  return { pn: e.pn, big: 1 };
}

async function listAll(env) {
  const types = {}; LIB_TYPES.forEach(t => (types[t] = []));
  let cursor, big = [], count = 0;
  do {
    const l = await env.PARTS.list({ prefix: "p:", cursor, limit: 1000 });
    for (const k of l.keys) {
      const type = k.name.split(":")[1];
      if (!types[type]) continue;
      const m = k.metadata;
      if (m && !m.big) { types[type].push(m); count++; } else big.push({ type, name: k.name });
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  /* entries too large for metadata: fetch individually (bounded to stay under the subrequest limit) */
  for (const b of big.slice(0, 30)) {
    const e = await env.PARTS.get(b.name, "json"); if (e) { types[b.type].push(e); count++; }
  }
  for (const t of LIB_TYPES) types[t].sort((a, b) => a.pn.localeCompare(b.pn));
  return { types, count };
}


/* ===================== DigiKey lookup (structured parameters) =====================
   GET /digikey?pn=<part number>[&raw=1]   needs the X-Lookup-Key password, like /part.
   Returns the first exact manufacturer-part-number match with its parameter list (name -> value text). */
let dkToken = null, dkExp = 0;
async function dkAuth(env) {
  if (dkToken && Date.now() < dkExp) return dkToken;
  const r = await fetch("https://api.digikey.com/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.DIGIKEY_ID, client_secret: env.DIGIKEY_SECRET, grant_type: "client_credentials" }),
  });
  if (!r.ok) throw new Error(`DigiKey sign-in failed (${r.status}). Check DIGIKEY_ID and DIGIKEY_SECRET.`);
  const j = await r.json();
  dkToken = j.access_token;
  dkExp = Date.now() + Math.max(60, (j.expires_in || 600) - 60) * 1000;
  return dkToken;
}

async function handleDigikey(url, env, cors) {
  const pn = (url.searchParams.get("pn") || "").trim();
  if (!PN_RE.test(pn)) return json({ error: "Invalid part number" }, 400, cors);
  if (!env.DIGIKEY_ID || !env.DIGIKEY_SECRET) return json({ error: "DIGIKEY_ID and DIGIKEY_SECRET secrets not set" }, 500, cors);
  try {
    const token = await dkAuth(env);
    const res = await fetch("https://api.digikey.com/products/v4/search/keyword", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, "X-DIGIKEY-Client-Id": env.DIGIKEY_ID,
        "Content-Type": "application/json", Accept: "application/json",
        "X-DIGIKEY-Locale-Site": "UK", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": "GBP",
      },
      body: JSON.stringify({ Keywords: pn, Limit: 10, Offset: 0 }),
    });
    if (res.status === 401) dkToken = null;
    if (!res.ok) return json({ error: `DigiKey returned ${res.status}` }, 502, cors);
    const data = await res.json();
    const prods = data.Products || [];
    const up = pn.toUpperCase();
    const p = prods.find(x => (x.ManufacturerProductNumber || "").toUpperCase() === up) ||
      prods.find(x => (x.ManufacturerProductNumber || "").toUpperCase().startsWith(up)) || prods[0];
    if (!p) return json({ found: false, query: pn }, 200, cors);
    const params = {};
    for (const a of p.Parameters || []) if (a.ParameterText) params[a.ParameterText] = a.ValueText || "";
    const cat = (p.Category && p.Category.Name) || "";
    const out = {
      found: true, query: pn,
      mpn: p.ManufacturerProductNumber,
      exact: (p.ManufacturerProductNumber || "").toUpperCase() === up,
      manufacturer: p.Manufacturer && p.Manufacturer.Name,
      description: p.Description && (p.Description.ProductDescription || p.Description.DetailedDescription),
      category: cat,
      datasheet: p.DatasheetUrl || null,
      productUrl: p.ProductUrl || null,
      parameters: params,
      otherMatches: Math.max(0, prods.length - 1),
    };
    return json(out, 200, cors);
  } catch (e) {
    return json({ error: String(e.message || "DigiKey lookup failed").slice(0, 200) }, 502, cors);
  }
}
