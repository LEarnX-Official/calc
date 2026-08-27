/**
 * Seeds a demo tenant so `npm start` shows something real immediately.
 * Idempotent: re-running resets the demo account rather than duplicating it.
 */
const fs = require('fs');
const path = require('path');
const { db, now, id, uniqueSlug } = require('./db');
const auth = require('./auth');

const DEMO_EMAIL = 'demo@quotecraft.app';
const DEMO_PASSWORD = 'demo1234';

const preset = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'verticals', 'residential-cleaning.json'), 'utf8')
);

const branding = {
  accent: '#5C4F87',
  headline: 'Get your instant price',
  subhead: 'Answer a few questions and see your price right now — no waiting on a callback.',
  ctaLabel: 'Email me this quote',
  showRecurring: true,
  showRange: true,
  showDuration: true,
  thanksMessage: "Thanks! We've got your details and will be in touch shortly to confirm your booking.",
  // The residential-cleaning preset is fully translated, so the demo shows the
  // language switch working rather than just claiming it exists.
  showLanguageToggle: true,
  headlineEs: 'Obtén tu precio al instante',
  subheadEs: 'Responde unas preguntas y mira tu precio ahora mismo — sin esperar una llamada.',
  ctaLabelEs: 'Envíame este presupuesto',
  thanksMessageEs: 'Gracias, ya tenemos tus datos. Te contactamos en breve para confirmar tu cita.'
};

const existing = db.prepare('SELECT * FROM tenants WHERE email = ?').get(DEMO_EMAIL);
let tenantId, slug;

if (existing) {
  tenantId = existing.id;
  slug = existing.slug;
  db.prepare('UPDATE tenants SET config_json=?, branding_json=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(preset), JSON.stringify(branding), now(), tenantId);
  db.prepare('DELETE FROM leads WHERE tenant_id = ?').run(tenantId);
  console.log('Reset existing demo tenant.');
} else {
  tenantId = id('ten');
  slug = uniqueSlug('Maple & Moss Cleaning');
  const t = now();
  db.prepare(`INSERT INTO tenants
    (id, slug, email, password_hash, business_name, vertical, plan, config_json, branding_json, notify_email, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tenantId, slug, DEMO_EMAIL, auth.hashPassword(DEMO_PASSWORD),
    'Maple & Moss Cleaning', 'residential-cleaning', 'pro',
    JSON.stringify(preset), JSON.stringify(branding), DEMO_EMAIL, t, t
  );
  console.log('Created demo tenant.');
}

// A few leads so the dashboard isn't an empty state on first look.
const Engine = require('../shared/engine');
const samples = [
  { name: 'Dana Whitfield', email: 'dana.w@example.com', phone: '(555) 018-2244', address: '18 Alder Court', status: 'new',
    input: { size: 's4', modifiers: { bedrooms: 3, fullBaths: 2, halfBaths: 1 }, service: 'standard', frequency: 'biweekly', addons: { oven: 1 } }, daysAgo: 0 },
  { name: 'Marcus Reed', email: 'm.reed@example.com', phone: '(555) 771-9043', address: '402 Kestrel Lane', status: 'contacted',
    input: { size: 's6', modifiers: { bedrooms: 4, fullBaths: 3, halfBaths: 1 }, service: 'deep', frequency: 'onetime', addons: { fridge: 1, windows: 6 } }, daysAgo: 2 },
  { name: 'Priya Raman', email: 'praman@example.com', phone: '(555) 330-1187', address: '7 Juniper Way', status: 'won',
    input: { size: 's3', modifiers: { bedrooms: 2, fullBaths: 1, halfBaths: 0 }, service: 'standard', frequency: 'weekly', addons: {} }, daysAgo: 5 },
  { name: 'Ellis Tran', email: 'ellis.tran@example.com', phone: '(555) 664-2210', address: '221 Foxglove Drive', status: 'new',
    input: { size: 's7', modifiers: { bedrooms: 5, fullBaths: 3, halfBaths: 2 }, service: 'moveout', frequency: 'onetime', addons: { cabinets: 1, fridge: 1 } }, daysAgo: 1 },
  { name: 'Sofia Iqbal', email: 'sofia.i@example.com', phone: '(555) 902-3345', address: '95 Bramble Street', status: 'lost',
    input: { size: 's2', modifiers: { bedrooms: 2, fullBaths: 1, halfBaths: 0 }, service: 'standard', frequency: 'monthly', addons: {} }, daysAgo: 9 }
];

const insert = db.prepare(`INSERT INTO leads
  (id, tenant_id, name, email, phone, address, note, quote_total, quote_json, input_json, source_url, status, webhook_state, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

samples.forEach(s => {
  const q = Engine.quote(preset, s.input);
  insert.run(
    id('lead'), tenantId, s.name, s.email, s.phone, s.address, null,
    q.total, JSON.stringify(q), JSON.stringify(s.input),
    'https://maplemoss.example.com/pricing', s.status, 'none',
    new Date(Date.now() - s.daysAgo * 864e5).toISOString()
  );
});

// Some widget views so the stats tiles have a denominator.
const ev = db.prepare('INSERT INTO events (tenant_id, kind, meta, created_at) VALUES (?,?,?,?)');
for (let i = 0; i < 47; i++) {
  ev.run(tenantId, 'widget_view', null, new Date(Date.now() - Math.floor(i / 3) * 864e5).toISOString());
}

console.log(`
  Demo account ready
  ──────────────────────────────────────────
  URL       http://localhost:3000/login
  Email     ${DEMO_EMAIL}
  Password  ${DEMO_PASSWORD}
  Widget    http://localhost:3000/w/${slug}
  ──────────────────────────────────────────
`);
