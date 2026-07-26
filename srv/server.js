const cds = require('@sap/cds');
const https = require('https');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Hop-by-hop headers must not be forwarded when proxying (RFC 7230).
const HOP_BY_HOP = ['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade'];

/** Route outbound to S/4 through HTTPS_PROXY unless the host is in NO_PROXY. */
function agentFor(hostname) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy) return undefined;                       // direct connection
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',').map(s => s.trim().replace(/^\./, '')).filter(Boolean);
  const bypass = noProxy.some(d => hostname === d || hostname.endsWith('.' + d));
  return bypass ? undefined : new HttpsProxyAgent(proxy);
}

/**
 * Local-dev proxy so the Fiori app (served by `cds watch`) can talk to the
 * draft-enabled S/4 service directly. The browser calls the S/4 OData path
 * same-origin (localhost:4004/sap/...); this middleware forwards it to the real
 * S/4 host, injecting the basic-auth credentials resolved from the CF service
 * binding (the `s4` profile) — so nothing secret ever reaches the browser.
 *
 * Only active when the S/4 remote is wired up (i.e. `cds watch --profile s4`);
 * otherwise it's a no-op. Requires `cf login` so the binding resolves.
 */
const REMOTE = 'ZUI_INVOICE_REVIEW_O4';

cds.on('bootstrap', app => {
  const cfg = cds.env.requires?.[REMOTE];
  if (!cfg?.credentials && !cfg?.binding) return;   // S/4 not wired -> no proxy

  // Resolve credentials once, lazily (connecting resolves the CF binding).
  let credsP;
  const creds = () => (credsP ||= cds.connect.to(REMOTE)
    .then(srv => srv.options?.credentials || cds.env.requires[REMOTE].credentials));

  app.use('/sap', async (req, res) => {
    let c;
    try { c = await creds(); } catch (e) {
      res.statusCode = 502; return res.end('S/4 credential resolution failed: ' + e.message);
    }
    if (!c?.url) { res.statusCode = 502; return res.end('S/4 credentials have no url'); }

    const target = new URL(c.url);
    const headers = { ...req.headers, host: target.host };
    for (const h of HOP_BY_HOP) delete headers[h];
    if (c.username) {
      headers.authorization = 'Basic ' + Buffer.from(`${c.username}:${c.password || ''}`).toString('base64');
    }

    const upstream = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      method: req.method,
      path: req.originalUrl,          // full /sap/... path == the S/4 service path
      headers,
      servername: target.hostname,    // SNI
      agent: agentFor(target.hostname),   // route via HTTPS_PROXY when set
      rejectUnauthorized: false       // tolerate internal/self-signed cert
    }, up => {
      res.writeHead(up.statusCode, up.headers);   // forwards x-csrf-token + set-cookie
      up.pipe(res);
    });
    upstream.on('error', e => {
      console.error(`[s4-dev-proxy] upstream error (${e.code || ''}) for ${req.method} ${req.originalUrl}:`, e.message);
      if (!res.headersSent) res.statusCode = 502;
      res.end('S/4 proxy error: ' + e.message);
    });
    req.pipe(upstream);              // streams request body ($batch, POST, PATCH)
  });

  console.log(`[s4-dev-proxy] mounted /sap -> S/4 (credentials resolved on first request)`);
});

module.exports = cds.server;         // delegate to the default CAP server
