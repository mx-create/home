# Mouser stock proxy

A tiny Cloudflare Worker that lets RC Standard Finder check live Mouser stock without exposing the API key.

## Set up (dashboard, no command line)
1. Get a free key: Mouser account, My Account, APIs, Search API, then sign up.
2. Cloudflare dashboard, Workers & Pages, Create, Create Worker. Name it `rc-stock`, deploy, then Edit code.
3. Paste in the contents of `worker.js` and deploy.
4. Settings, Variables and Secrets, Add: type **Secret**, name `MOUSER_KEY`, value is your key.
5. Optional variable `ALLOWED_ORIGINS`, default `https://mxdesign.uk`. Add more origins separated by commas.
6. Copy the Worker URL (`https://rc-stock.<your-subdomain>.workers.dev`) and put it in `STOCK_API` near the top of the script in `../index.html`.

## Check it
`https://rc-stock.<your-subdomain>.workers.dev/stock?q=22uF%20X5R%2025V%200805` returns JSON with in-stock parts.
(A browser visit shows the data; the page itself only accepts calls from the allowed origin.)

## Behaviour
- Searches Mouser with `InStock`, returns up to 25 parts trimmed to part number, maker, stock, 1-off and 100-off price, links.
- Caches identical searches for 10 minutes to protect Mouser's rate limits.
- The page filters results by value, size, dielectric and voltage before showing them.
