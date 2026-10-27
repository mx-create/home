# Mouser lookup worker

Cloudflare Worker that Buck Designer calls for part lookups. It keeps the Mouser Search API key on the server and returns the part's manufacturer, description, datasheet link, stock, lifecycle and price breaks.

Deployed at `https://mouser.mail-manu-mx.workers.dev`. Usage: `GET /part?pn=<manufacturer part number>`.

Setup: paste `worker.js` into a Cloudflare Worker and add the Mouser Search API key as a Secret named `MOUSER_KEY`. Never commit the key. Requests are accepted only from mxdesign.uk (and localhost for testing), and each part is cached for 24 hours.

## Shared parts library (one-time setup)

The same worker also stores the shared parts library used by Buck Designer and Buck Compensation (routes under `/lib`). Parts saved in either tool appear in both, for everyone.

1. Cloudflare dashboard → Workers & Pages → KV → Create namespace named `mx-parts`.
2. Worker → Settings → Bindings → Add → KV namespace → variable name `PARTS` → choose `mx-parts`.
3. Paste the updated `worker.js` and Deploy.
4. Check `https://<worker>.workers.dev/lib` returns `{"types":{...},"count":0}`.

Until step 2 is done the tools show "library not set up" and keep working from this device's copy. Entries saved meanwhile are queued and shared automatically once the library is reachable.

Notes
- Anyone who can open the pages can add, edit or delete parts. The origin check only stops casual misuse; it is not authentication.
- Every overwrite or delete keeps the previous version for 90 days: `GET /lib/history?type=cap&pn=<PN>`.
- Saving merges fields, so the two tools never wipe each other's values. DC-bias loss is not stored because it depends on the design voltage.
- Cloudflare free tier allows 1000 KV writes a day, plenty for a parts library.

## Mouser lookup password

Mouser lookups spend the shared API key, so the worker only answers when the request carries the owner's password.

1. Worker → Settings → Variables and Secrets → add Secret `LOOKUP_PASS` with a password only you know.
2. The first time you press a lookup button (in Designer, Compensation or the Parts Library page) the tool asks for it, then remembers it on that device. Anyone without it can still view, edit, import and verify parts, but cannot run Mouser lookups.
3. Until `LOOKUP_PASS` is set, lookups return an error and do nothing.

## Parts library page and CSV import

`/parts_library/` is a live table of the shared library: search, filter by verified, edit any cell, tick Verified, add a part, delete a part. Import takes a CSV (use Download template on the page; the columns are `type, pn, subtype, manufacturer, description, datasheet, verified`, then one column per value). Imported parts are marked not verified unless the verified column says yes. Imports are limited to 200 parts per file, and each part is one KV write against the free tier's 1000 a day.
