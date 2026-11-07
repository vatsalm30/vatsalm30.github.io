import DASHBOARD_HTML from './dashboard.html';

const ALLOWED_ORIGINS = [/^https:\/\/vatsalm30\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|pingdom|monitor|curl|wget|python-requests|httpclient/i;
const TYPES = new Set(['pageview', 'click', 'section', 'engage']);
// 1x1 transparent GIF
const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));

const str = (v, n = 300) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const int = (v, max) => (Number.isFinite(v) ? Math.max(0, Math.min(Math.round(v), max)) : null);

function originOk(origin) {
  return !origin || ALLOWED_ORIGINS.some(re => re.test(origin));
}

function cors(origin) {
  return originOk(origin) && origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
    : {};
}

function parseUA(ua = '') {
  const device = /iPad|Tablet/i.test(ua) ? 'Tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'Mobile' : 'Desktop';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'Other';
  return { device, browser, os };
}

function context(req) {
  const ua = req.headers.get('User-Agent') || '';
  const cf = req.cf || {};
  return { bot: BOT_RE.test(ua), ...parseUA(ua), country: cf.country || null, city: cf.city || null };
}

async function insert(env, rows) {
  if (!rows.length) return;
  const stmt = env.DB.prepare(
    `INSERT INTO events (ts,type,visitor,session,path,referrer,target,href,duration_ms,scroll_pct,country,city,device,browser,os,screen,utm_source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  await env.DB.batch(rows.map(r => stmt.bind(
    r.ts, r.type, r.visitor, r.session, r.path, r.referrer, r.target, r.href, r.duration_ms, r.scroll_pct,
    r.country, r.city, r.device, r.browser, r.os, r.screen, r.utm_source
  )));
}

async function collect(req, env, ctx) {
  const origin = req.headers.get('Origin');
  if (!originOk(origin)) return new Response('forbidden', { status: 403 });
  const c = context(req);
  if (c.bot) return new Response(null, { status: 204, headers: cors(origin) });

  let body;
  try { body = JSON.parse(await req.text()); } catch { return new Response('bad json', { status: 400, headers: cors(origin) }); }
  const now = Date.now();
  const rows = (Array.isArray(body.events) ? body.events : []).slice(0, 50)
    .filter(e => e && TYPES.has(e.type))
    .map(e => ({
      ts: now, type: e.type, visitor: str(body.v, 40), session: str(body.s, 40),
      path: str(e.path, 200), referrer: str(e.ref), target: str(e.target, 120), href: str(e.href),
      duration_ms: int(e.dur, 6 * 3600 * 1000), scroll_pct: int(e.scroll, 100),
      country: c.country, city: c.city, device: c.device, browser: c.browser, os: c.os,
      screen: str(body.scr, 20), utm_source: str(e.utm, 80),
    }));
  ctx.waitUntil(insert(env, rows));
  return new Response(null, { status: 204, headers: cors(origin) });
}

function pixel(req, env, ctx) {
  const c = context(req);
  const u = new URL(req.url);
  if (!c.bot) {
    ctx.waitUntil(insert(env, [{
      ts: Date.now(), type: 'pixel', visitor: null, session: null,
      path: str(u.searchParams.get('p'), 200) || '/', referrer: str(req.headers.get('Referer')),
      target: null, href: null, duration_ms: null, scroll_pct: null,
      country: c.country, city: c.city, device: c.device, browser: c.browser, os: c.os, screen: null, utm_source: null,
    }]));
  }
  return new Response(PIXEL, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' } });
}

function authorized(req, env) {
  if (!env.DASH_PASSWORD) return false;
  const h = req.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  try {
    const [, pass] = atob(h.slice(6)).split(':');
    return pass === env.DASH_PASSWORD;
  } catch { return false; }
}

const needAuth = () => new Response('Authentication required', {
  status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Site analytics", charset="UTF-8"' },
});

async function stats(req, env) {
  const days = Math.min(Math.max(parseInt(new URL(req.url).searchParams.get('days')) || 7, 1), 365);
  const since = Date.now() - days * 86400000;
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);

  const [totals, time, daily, clicks, refs, countries, devices, browsers, sections, durations, sessions, live, pixelViews] = await env.DB.batch([
    q(`SELECT COUNT(*) pageviews, COUNT(DISTINCT visitor) visitors, COUNT(DISTINCT session) sessions
       FROM events WHERE type='pageview' AND ts>?`, since),
    q(`SELECT AVG(d) avg_ms, AVG(sc) avg_scroll,
              SUM(CASE WHEN d<10000 AND c=0 THEN 1 ELSE 0 END)*1.0/MAX(COUNT(*),1) bounce
       FROM (SELECT session, SUM(CASE WHEN type='engage' THEN duration_ms ELSE 0 END) d,
                    MAX(scroll_pct) sc, SUM(type='click') c
             FROM events WHERE ts>? AND session IS NOT NULL GROUP BY session)`, since),
    q(`SELECT date(ts/1000,'unixepoch') day, COUNT(*) pageviews, COUNT(DISTINCT visitor) visitors
       FROM events WHERE type='pageview' AND ts>? GROUP BY day ORDER BY day`, since),
    q(`SELECT target, MAX(href) href, COUNT(*) n FROM events WHERE type='click' AND ts>?
       GROUP BY target ORDER BY n DESC LIMIT 25`, since),
    q(`SELECT COALESCE(NULLIF(referrer,''),'Direct / none') ref, COUNT(*) n FROM events
       WHERE type='pageview' AND ts>? GROUP BY ref ORDER BY n DESC LIMIT 15`, since),
    q(`SELECT COALESCE(country,'??') k, COUNT(DISTINCT session) n FROM events WHERE type='pageview' AND ts>? GROUP BY k ORDER BY n DESC LIMIT 15`, since),
    q(`SELECT device k, COUNT(DISTINCT session) n FROM events WHERE type='pageview' AND ts>? GROUP BY k ORDER BY n DESC`, since),
    q(`SELECT browser k, COUNT(DISTINCT session) n FROM events WHERE type='pageview' AND ts>? GROUP BY k ORDER BY n DESC`, since),
    q(`SELECT target k, COUNT(DISTINCT session) n FROM events WHERE type='section' AND ts>? GROUP BY k ORDER BY n DESC`, since),
    q(`SELECT CASE WHEN d<10000 THEN '<10s' WHEN d<30000 THEN '10–30s' WHEN d<60000 THEN '30–60s'
                   WHEN d<180000 THEN '1–3m' WHEN d<600000 THEN '3–10m' ELSE '10m+' END k, COUNT(*) n
       FROM (SELECT session, SUM(duration_ms) d FROM events WHERE type='engage' AND ts>? GROUP BY session)
       GROUP BY k`, since),
    q(`SELECT session, MIN(ts) start, MAX(country) country, MAX(city) city, MAX(device) device, MAX(browser) browser,
              MAX(os) os, MAX(CASE WHEN type='pageview' THEN referrer END) ref,
              SUM(CASE WHEN type='engage' THEN duration_ms ELSE 0 END) dur,
              SUM(type='click') clicks, MAX(scroll_pct) scroll,
              GROUP_CONCAT(CASE WHEN type='click' THEN target END, ' → ') click_path
       FROM events WHERE ts>? AND session IS NOT NULL GROUP BY session ORDER BY start DESC LIMIT 30`, since),
    q(`SELECT COUNT(DISTINCT session) n FROM events WHERE ts>?`, Date.now() - 5 * 60000),
    q(`SELECT COUNT(*) n FROM events WHERE type='pixel' AND ts>?`, since),
  ]);

  const r = x => x.results;
  return Response.json({
    days, generated: Date.now(),
    totals: { ...r(totals)[0], ...r(time)[0], live: r(live)[0].n, pixel: r(pixelViews)[0].n },
    daily: r(daily), clicks: r(clicks), referrers: r(refs), countries: r(countries),
    devices: r(devices), browsers: r(browsers), sections: r(sections), durations: r(durations), sessions: r(sessions),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (url.pathname === '/e' && req.method === 'POST') return collect(req, env, ctx);
    if (url.pathname === '/px') return pixel(req, env, ctx);

    if (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname === '/api/stats') {
      if (!authorized(req, env)) return needAuth();
      if (url.pathname === '/api/stats') return stats(req, env);
      return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    return new Response('not found', { status: 404 });
  },
};
