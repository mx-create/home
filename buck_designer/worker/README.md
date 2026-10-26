# Mouser lookup worker

Cloudflare Worker that Buck Designer calls for part lookups. It keeps the Mouser Search API key on the server and returns the part's manufacturer, description, datasheet link, stock, lifecycle and price breaks.

Deployed at `https://mouser.mail-manu-mx.workers.dev`. Usage: `GET /part?pn=<manufacturer part number>`.

Setup: paste `worker.js` into a Cloudflare Worker and add the Mouser Search API key as a Secret named `MOUSER_KEY`. Never commit the key. Requests are accepted only from mxdesign.uk (and localhost for testing), and each part is cached for 24 hours.
