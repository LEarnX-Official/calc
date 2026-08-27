/**
 * QuoteCraft server.
 *
 * Three surfaces:
 *   /            marketing + auth pages         (public)
 *   /app         tenant dashboard               (session auth)
 *   /api/public  widget + embed endpoints       (public, CORS-open by design)
 *
 * The public API is intentionally open: the widget runs on the tenant's own
 * website, on a domain we don't control. Config served there is non-sensitive
 * (prices are shown to customers anyway) and lead POSTs are rate limited.
 */
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const { db, now, id, uniqueSlug, logEvent } = require('./db');
const auth = require('./auth');
const Engine = require('../shared/engine');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.disable('x-powered-by');

/* ── verticals ─────────────────────────────────────────────────────────── */
const VERTICAL_DIR = path.join(ROOT, 'verticals');
const VERTICALS = {};
fs.readdirSync(VERTICAL_DIR).filter(f => f.endsWith('.json')).forEach(f => {
  const v = JSON.parse(fs.readFileSync(path.join(VERTICAL_DIR, f), 'utf8'));
  VERTICALS[v.vertical] = v;
});
console.log('Loaded verticals:', Object.keys(VERTICALS).join(', '));

const DEFAULT_BRANDING = {
  accent: '#5C4F87',
  headline: 'Get your instant price',
  subhead: 'Answer a few questions and see your price right now — no waiting on a callback.',
  ctaLabel: 'Email me this quote',
  showRecurring: true,
  showRange: true,
  showDuration: true,
  thanksMessage: "Thanks! We've got your details and will be in touch shortly to confirm your booking.",
  // On by default, but it only has an effect once the tenant has written some
  // Spanish — the widget checks that before drawing anything.
  showLanguageToggle: true,
  headlineEs: 'Obtén tu precio al instante',
  subheadEs: 'Responde unas preguntas y mira tu precio ahora mismo — sin esperar una llamada.',
  ctaLabelEs: 'Envíame este presupuesto',
  thanksMessageEs: 'Gracias, ya tenemos tus datos. Te contactamos en breve para confirmar.'
};

/* ── tiny in-memory rate limiter ───────────────────────────────────────── */
const hits = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const k = key(req);
    const t = Date.now();
    let rec = hits.get(k);
    if (!rec || t > rec.reset) { rec = { count: 0, reset: t + windowMs }; hits.set(k, rec); }
    rec.count++;
    if (rec.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    next();
  };
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of hits) if (t > v.reset) hits.delete(k);
}, 60000).unref();

const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';

/* ── helpers ───────────────────────────────────────────────────────────── */
function parseTenant(row) {
  return {
    id: row.id, slug: row.slug, email: row.email,
    businessName: row.business_name, vertical: row.vertical, plan: row.plan,
    config: JSON.parse(row.config_json),
    branding: { ...DEFAULT_BRANDING, ...JSON.parse(row.branding_json || '{}') },
    webhookUrl: row.webhook_url, notifyEmail: row.notify_email,
    createdAt: row.created_at
  };
}
const getTenantBySlug = slug =>
  db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);

const validEmail = e => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length < 200;
// Strip control characters (CR/LF included) — they have no place in a name or
// address, and they are what header/log-injection tricks rely on.
const clean = (s, max = 300) =>
  s == null ? null : String(s).slice(0, max).replace(/[\u0000-\u001F\u007F]/g, '').trim() || null;

/* ══════════════════════════════════════════════════════════════════════
   AUTH
   ══════════════════════════════════════════════════════════════════════ */
app.post('/api/auth/signup',
  rateLimit({ windowMs: 3600e3, max: 20, key: ipOf }),
  (req, res) => {
    const { email, password, businessName, vertical } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!businessName || !String(businessName).trim()) return res.status(400).json({ error: 'Business name is required.' });
    const vert = VERTICALS[vertical] ? vertical : 'residential-cleaning';

    const lower = String(email).toLowerCase().trim();
    if (db.prepare('SELECT 1 FROM tenants WHERE email = ?').get(lower)) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const preset = JSON.parse(JSON.stringify(VERTICALS[vert]));
    const name = String(businessName).trim().slice(0, 120);
    const tenantId = id('ten');
    const slug = uniqueSlug(name);
    const t = now();

    db.prepare(`INSERT INTO tenants
      (id, slug, email, password_hash, business_name, vertical, plan, config_json, branding_json, notify_email, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId, slug, lower, auth.hashPassword(String(password)), name, vert, 'trial',
      JSON.stringify(preset), JSON.stringify(DEFAULT_BRANDING), lower, t, t
    );

    const s = auth.createSession(tenantId);
    auth.setSessionCookie(res, s.token, s.expires);
    logEvent(tenantId, 'signup', { vertical: vert });
    res.json({ ok: true, slug });
  });

app.post('/api/auth/login',
  rateLimit({ windowMs: 900e3, max: 30, key: ipOf }),
  (req, res) => {
    const { email, password } = req.body || {};
    const row = db.prepare('SELECT * FROM tenants WHERE email = ?')
      .get(String(email || '').toLowerCase().trim());
    if (!row || !auth.verifyPassword(String(password || ''), row.password_hash)) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const s = auth.createSession(row.id);
    auth.setSessionCookie(res, s.token, s.expires);
    logEvent(row.id, 'login');
    res.json({ ok: true, slug: row.slug });
  });

app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(req.cookies && req.cookies[auth.COOKIE]);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const row = auth.tenantFromRequest(req);
  if (!row) return res.status(401).json({ error: 'Not signed in.' });
  const t = parseTenant(row);
  delete t.email;
  res.json({ ok: true, tenant: { ...t, email: row.email } });
});

/* ══════════════════════════════════════════════════════════════════════
   DASHBOARD API
   ══════════════════════════════════════════════════════════════════════ */
app.get('/api/verticals', (_req, res) => {
  res.json({
    ok: true,
    verticals: Object.values(VERTICALS).map(v => ({
      id: v.vertical, name: v.name, tagline: v.tagline, icon: v.icon
    }))
  });
});

app.get('/api/config', auth.requireAuth, (req, res) => {
  res.json({ ok: true, tenant: parseTenant(req.tenant) });
});

app.put('/api/config', auth.requireAuth, (req, res) => {
  const { config, branding, businessName, webhookUrl, notifyEmail } = req.body || {};
  if (!config) return res.status(400).json({ error: 'Missing config.' });

  const errors = Engine.validateConfig(config);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  if (webhookUrl && !/^https:\/\/.+/i.test(String(webhookUrl))) {
    return res.status(400).json({ error: 'Webhook URL must start with https://' });
  }
  if (notifyEmail && !validEmail(notifyEmail)) {
    return res.status(400).json({ error: 'Notification email is not valid.' });
  }

  db.prepare(`UPDATE tenants SET
      config_json=?, branding_json=?, business_name=?, webhook_url=?, notify_email=?, updated_at=?
      WHERE id=?`).run(
    JSON.stringify(config),
    JSON.stringify({ ...DEFAULT_BRANDING, ...(branding || {}) }),
    String(businessName || req.tenant.business_name).slice(0, 120),
    webhookUrl ? String(webhookUrl).slice(0, 500) : null,
    notifyEmail ? String(notifyEmail).toLowerCase().slice(0, 200) : null,
    now(), req.tenant.id
  );
  logEvent(req.tenant.id, 'config_saved');
  res.json({ ok: true });
});

app.post('/api/config/reset', auth.requireAuth, (req, res) => {
  const vert = VERTICALS[req.body && req.body.vertical] ? req.body.vertical : req.tenant.vertical;
  const preset = JSON.parse(JSON.stringify(VERTICALS[vert]));
  db.prepare('UPDATE tenants SET config_json=?, vertical=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(preset), vert, now(), req.tenant.id);
  res.json({ ok: true, config: preset, vertical: vert });
});

app.get('/api/leads', auth.requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const rows = db.prepare(
    'SELECT * FROM leads WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(req.tenant.id, limit);

  res.json({
    ok: true,
    leads: rows.map(r => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone, address: r.address,
      note: r.note, quoteTotal: r.quote_total,
      quote: r.quote_json ? JSON.parse(r.quote_json) : null,
      input: r.input_json ? JSON.parse(r.input_json) : null,
      sourceUrl: r.source_url, status: r.status,
      webhookState: r.webhook_state, createdAt: r.created_at
    }))
  });
});

app.patch('/api/leads/:id', auth.requireAuth, (req, res) => {
  const allowed = ['new', 'contacted', 'won', 'lost'];
  const status = String((req.body || {}).status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  const info = db.prepare('UPDATE leads SET status=? WHERE id=? AND tenant_id=?')
    .run(status, req.params.id, req.tenant.id);
  if (!info.changes) return res.status(404).json({ error: 'Lead not found.' });
  res.json({ ok: true });
});

app.get('/api/leads.csv', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM leads WHERE tenant_id=? ORDER BY created_at DESC').all(req.tenant.id);
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['Date', 'Name', 'Email', 'Phone', 'Address', 'Quote', 'Status', 'Note', 'Source'];
  const lines = [head.join(',')].concat(rows.map(r => [
    r.created_at, r.name, r.email, r.phone, r.address, r.quote_total, r.status, r.note, r.source_url
  ].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send(lines.join('\n'));
});

app.get('/api/stats', auth.requireAuth, (req, res) => {
  const tid = req.tenant.id;
  const one = (sql, ...p) => db.prepare(sql).get(tid, ...p) || {};
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  res.json({
    ok: true,
    stats: {
      totalLeads: one('SELECT COUNT(*) c FROM leads WHERE tenant_id=?').c || 0,
      newLeads: one("SELECT COUNT(*) c FROM leads WHERE tenant_id=? AND status='new'").c || 0,
      leads30: one('SELECT COUNT(*) c FROM leads WHERE tenant_id=? AND created_at > ?', since).c || 0,
      pipeline: Math.round(one("SELECT COALESCE(SUM(quote_total),0) s FROM leads WHERE tenant_id=? AND status IN ('new','contacted')").s || 0),
      won: Math.round(one("SELECT COALESCE(SUM(quote_total),0) s FROM leads WHERE tenant_id=? AND status='won'").s || 0),
      quotesViewed: one("SELECT COUNT(*) c FROM events WHERE tenant_id=? AND kind='widget_view'").c || 0
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
   PUBLIC WIDGET API
   ══════════════════════════════════════════════════════════════════════ */
app.use('/api/public', (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  next();
});
app.options('/api/public/*', (_req, res) => res.sendStatus(204));

/** Public config — prices only, nothing private. */
app.get('/api/public/config/:slug', (req, res) => {
  const row = getTenantBySlug(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Calculator not found.' });
  const t = parseTenant(row);
  logEvent(t.id, 'widget_view', { ref: clean(req.headers.referer, 300) });
  res.json({
    ok: true,
    slug: t.slug,
    businessName: t.businessName,
    vertical: t.vertical,
    config: t.config,
    branding: t.branding
  });
});

/** Server-side quote — the number of record, so a tampered client can't forge one. */
app.post('/api/public/quote/:slug',
  rateLimit({ windowMs: 60e3, max: 120, key: req => 'q:' + ipOf(req) }),
  (req, res) => {
    const row = getTenantBySlug(req.params.slug);
    if (!row) return res.status(404).json({ error: 'Calculator not found.' });
    const config = JSON.parse(row.config_json);
    res.json({ ok: true, quote: Engine.quote(config, req.body || {}) });
  });

/** Lead capture — the point of the whole product. */
app.post('/api/public/lead/:slug',
  rateLimit({ windowMs: 3600e3, max: 40, key: req => 'l:' + ipOf(req) }),
  async (req, res) => {
    const row = getTenantBySlug(req.params.slug);
    if (!row) return res.status(404).json({ error: 'Calculator not found.' });

    const b = req.body || {};
    if (b.company_website) return res.json({ ok: true }); // honeypot: bots fill hidden fields
    if (!validEmail(b.email) && !clean(b.phone, 40)) {
      return res.status(400).json({ error: 'Please provide an email address or phone number.' });
    }

    const tenant = parseTenant(row);
    // The language rides on the input, but accept a top-level one too so a
    // caller posting straight to the API doesn't have to know where it lives.
    const input = Object.assign({}, b.input || {});
    if (!input.lang && b.lang) input.lang = b.lang;
    const quote = Engine.quote(tenant.config, input);
    const leadId = id('lead');

    db.prepare(`INSERT INTO leads
      (id, tenant_id, name, email, phone, address, note, quote_total, quote_json, input_json, source_url, status, webhook_state, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      leadId, tenant.id,
      clean(b.name, 120), validEmail(b.email) ? String(b.email).toLowerCase().slice(0, 200) : null,
      clean(b.phone, 40), clean(b.address, 300), clean(b.note, 1000),
      quote.ok && !quote.isCustom ? quote.total : null,
      JSON.stringify(quote), JSON.stringify(input),
      clean(b.sourceUrl || req.headers.referer, 300),
      'new', tenant.webhookUrl ? 'pending' : 'none', now()
    );
    logEvent(tenant.id, 'lead', { total: quote.total, lang: quote.lang });

    // Respond immediately — the customer shouldn't wait on someone else's CRM.
    // The thank-you goes back in whichever language they filled the form in.
    res.json({
      ok: true,
      message: Engine.label(tenant.branding, 'thanksMessage', quote.lang)
    });

    if (tenant.webhookUrl) forwardToWebhook(tenant, leadId, b, quote);
  });

/**
 * Fire-and-forget webhook delivery with one retry. We are not a CRM: this hands
 * the lead to whatever the tenant already uses (Zapier, Make, HighLevel) and
 * records whether it landed.
 */
async function forwardToWebhook(tenant, leadId, body, quote) {
  const payload = {
    event: 'lead.created',
    leadId,
    business: tenant.businessName,
    slug: tenant.slug,
    createdAt: now(),
    contact: {
      name: clean(body.name, 120), email: body.email || null,
      phone: clean(body.phone, 40), address: clean(body.address, 300)
    },
    note: clean(body.note, 1000),
    // Worth having downstream: whoever schedules this needs to know how many
    // people to send, and whoever calls the customer needs to know which
    // language they filled the form in.
    language: quote.lang || 'en',
    quote: quote.ok && !quote.isCustom ? {
      total: quote.total, currency: quote.currency,
      service: quote.serviceLabel, frequency: quote.frequencyLabel,
      durationMinutes: quote.durationMinutes,
      crewSize: quote.crewSize, crew: quote.crewLabel,
      isCustomQuote: false
    } : { isCustomQuote: true },
    selections: body.input || {},
    sourceUrl: clean(body.sourceUrl, 300)
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(tenant.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'QuoteCraft/1.0' },
        body: JSON.stringify(payload),
        signal: ctl.signal
      });
      clearTimeout(timer);
      if (r.ok) {
        db.prepare('UPDATE leads SET webhook_state=? WHERE id=?').run('delivered', leadId);
        return;
      }
      if (attempt === 2) {
        db.prepare('UPDATE leads SET webhook_state=? WHERE id=?').run('failed_' + r.status, leadId);
      }
    } catch (e) {
      if (attempt === 2) {
        db.prepare('UPDATE leads SET webhook_state=? WHERE id=?').run('failed', leadId);
        console.warn('Webhook failed for', tenant.slug, '-', e.message);
      }
    }
    if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
  }
}

/** Lets the dashboard prove the webhook works before a real lead depends on it. */
app.post('/api/webhook/test', auth.requireAuth, async (req, res) => {
  const url = (req.body || {}).url;
  if (!/^https:\/\/.+/i.test(String(url || ''))) {
    return res.status(400).json({ error: 'Webhook URL must start with https://' });
  }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'QuoteCraft/1.0' },
      body: JSON.stringify({
        event: 'lead.created', test: true,
        business: req.tenant.business_name,
        contact: { name: 'Test Lead', email: 'test@example.com', phone: '555-0100', address: '1 Test Street' },
        quote: { total: 249, currency: 'USD', service: 'Standard Clean', frequency: 'Every 2 weeks' }
      }),
      signal: ctl.signal
    });
    clearTimeout(timer);
    res.json({ ok: r.ok, status: r.status, message: r.ok ? 'Webhook accepted the test payload.' : 'Endpoint responded ' + r.status });
  } catch (e) {
    res.json({ ok: false, message: 'Could not reach that URL: ' + e.message });
  }
});

/* ══════════════════════════════════════════════════════════════════════
   STATIC + PAGES
   ══════════════════════════════════════════════════════════════════════ */
app.use('/shared', express.static(path.join(ROOT, 'shared'), { maxAge: '1h' }));
app.use('/assets', express.static(path.join(ROOT, 'public', 'assets'), { maxAge: '1h' }));

/** The one-line embed loader. Cached briefly so fixes propagate fast. */
app.get('/embed.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(path.join(ROOT, 'widget', 'embed.js'));
});

/** Widget iframe. Framing by third parties is the entire point, so no X-Frame-Options. */
app.get('/w/:slug', (req, res) => {
  if (!getTenantBySlug(req.params.slug)) return res.status(404).send('Calculator not found.');
  res.sendFile(path.join(ROOT, 'widget', 'widget.html'));
});
app.get('/widget/widget.js', (_req, res) => res.sendFile(path.join(ROOT, 'widget', 'widget.js')));

app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/signup', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'signup.html')));
app.get('/login', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'login.html')));
app.get('/demo', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'demo.html')));

app.get('/app', (req, res) => {
  if (!auth.tenantFromRequest(req)) return res.redirect('/login');
  res.sendFile(path.join(ROOT, 'public', 'app', 'dashboard.html'));
});
app.use('/app', express.static(path.join(ROOT, 'public', 'app')));
app.use(express.static(path.join(ROOT, 'public')));

app.use((_req, res) => res.status(404).sendFile(path.join(ROOT, 'public', '404.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

auth.purgeExpiredSessions();
app.listen(PORT, () => {
  console.log(`\n  QuoteCraft running → http://localhost:${PORT}\n`);
});
