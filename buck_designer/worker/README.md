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
