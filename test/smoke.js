/**
 * Headless smoke test. Loads every page in a real browser, fails on any console
 * error, uncaught exception, or failed network request, and checks that the
 * pages actually rendered their content rather than just returning 200.
 *
 * Not part of `npm test` (that's the engine, which has no browser dependency).
 * Run with the server up:  node test/smoke.js
 */
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE || 'http://localhost:3000';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome-stable';

const PAGES = [
  { path: '/', expect: ['QuoteCraft', 'price themselves'] },
  { path: '/signup', expect: ['Create your account'] },
  { path: '/login', expect: ['Welcome back'] },
  { path: '/demo', expect: ['This is the real thing'] },
  { path: '/nope', expect: ['404'], status: 404 },
  { path: '/w/maple-moss-cleaning', expect: [] }
];

const VIEWS = ['overview', 'leads', 'pricing', 'services', 'branding', 'install', 'settings'];

let failures = 0;
const fail = (where, msg) => { failures++; console.log(`  ✗ ${where}: ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

function watch(page, label, expectStatus) {
  page.on('console', m => {
    if (m.type() !== 'error') return;
    // A page we deliberately fetch expecting a 404 logs its own status as a
    // console error. That's the test's doing, not a defect in the page.
    if (expectStatus >= 400 && /status of \d+/.test(m.text())) return;
    fail(label, 'console error: ' + m.text());
  });
  page.on('pageerror', e => fail(label, 'uncaught: ' + e.message));
  page.on('requestfailed', r => {
    // favicon 404s are noise, not a defect
    if (!r.url().includes('favicon')) fail(label, 'request failed: ' + r.url());
  });
  page.on('response', r => {
    const u = new URL(r.url());
    if (u.origin !== new URL(BASE).origin) return;      // ignore Google Fonts etc
    if (r.status() >= 400 && !u.pathname.startsWith('/nope') && !u.pathname.includes('favicon')) {
      fail(label, `${r.status()} on ${u.pathname}`);
    }
  });
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  // ── public pages ──
  console.log('\nPublic pages');
  for (const spec of PAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    watch(page, spec.path, spec.status);

    const res = await page.goto(BASE + spec.path, { waitUntil: 'networkidle0', timeout: 20000 });
    const want = spec.status || 200;
    if (res.status() !== want) fail(spec.path, `status ${res.status()}, wanted ${want}`);

    const text = await page.evaluate(() => document.body.innerText);
    for (const s of spec.expect) {
      if (!text.includes(s)) fail(spec.path, `missing text "${s}"`);
    }

    // Nothing should overflow the viewport horizontally.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 2) fail(spec.path, `horizontal overflow of ${overflow}px`);

    pass(`${spec.path} (${text.length} chars of text)`);
    await page.close();
  }

  // ── the embed, mounted on a fake host page ──
  console.log('\nEmbed loader');
  {
    const page = await browser.newPage();
    watch(page, '/demo embed');
    await page.goto(BASE + '/demo', { waitUntil: 'networkidle0' });
    const frame = await page.$('iframe[data-quotecraft-frame]');
    if (!frame) fail('/demo', 'embed iframe never mounted');
    else {
      // Give the widget a moment to post its height up.
      await new Promise(r => setTimeout(r, 1200));
      const h = await page.evaluate(el => parseInt(el.style.height, 10), frame);
      if (!(h > 400)) fail('/demo', `iframe height is ${h}px — postMessage resize did not happen`);
      else pass(`iframe auto-resized to ${h}px`);

      const inner = await frame.contentFrame();
      const t = await inner.evaluate(() => document.body.innerText);
      if (!/\$/.test(t)) fail('/demo', 'widget rendered no price');
      else pass('widget rendered a price inside the frame');

      // ── team size ──
      const crew = await inner.evaluate(() => {
        const tiles = [...document.querySelectorAll('[data-crew]')];
        if (tiles.length < 2) return { tiles: tiles.length };
        const price = () => document.querySelector('.qp-price').textContent.trim();
        const time = () => (document.querySelector('.qp-time .t-v') || {}).textContent;
        const before = { price: price(), time: time() };
        tiles[tiles.length - 1].click();
        return {
          tiles: tiles.length, before, after: { price: price(), time: time() },
          active: (document.querySelector('[data-crew].active') || {}).textContent
        };
      });
      if (crew.tiles < 2) fail('/demo', `team-size picker showed ${crew.tiles} option(s)`);
      else if (crew.before.price !== crew.after.price) {
        fail('/demo', `picking a bigger team changed the price ${crew.before.price} → ${crew.after.price}`);
      } else if (crew.before.time === crew.after.time) {
        fail('/demo', `picking a bigger team did not shorten the visit (${crew.after.time})`);
      } else {
        pass(`team of ${crew.tiles} options: price held at ${crew.after.price}, ` +
             `time ${crew.before.time} → ${crew.after.time}`);
      }

      // ── language toggle ──
      const es = await inner.evaluate(async () => {
        const btn = document.querySelector('[data-lang="es"]');
        if (!btn) return { missing: true };
        const before = document.body.innerText;
        btn.click();
        await new Promise(r => setTimeout(r, 120));
        return {
          before, after: document.body.innerText,
          price: document.querySelector('.qp-price').textContent.trim(),
          htmlLang: document.documentElement.lang
        };
      });
      if (es.missing) fail('/demo', 'no Spanish toggle rendered');
      else if (es.before === es.after) fail('/demo', 'switching to Spanish changed nothing');
      else if (!/Equipo de|presupuesto|Limpieza/i.test(es.after)) {
        fail('/demo', 'Spanish mode still reads as English');
      } else if (es.htmlLang !== 'es') {
        fail('/demo', `<html lang> stayed "${es.htmlLang}" after switching`);
      } else {
        pass(`switched to Spanish (price stayed ${es.price}, lang="${es.htmlLang}")`);
      }
    }
    await page.close();
  }

  // ── dashboard, signed in ──
  console.log('\nDashboard');
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    watch(page, '/app');

    await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
    await page.type('#email', 'demo@quotecraft.app');
    await page.type('#password', 'demo1234');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      page.click('#submit')
    ]);
    if (!/\/app(#|$)/.test(page.url())) fail('/login', 'did not land on /app, got ' + page.url());
    else pass('signed in and redirected to /app');

    await page.waitForSelector('.view', { timeout: 10000 });

    for (const view of VIEWS) {
      await page.evaluate(v => {
        document.querySelector(`.side-link[data-view="${v}"]`).click();
      }, view);
      await new Promise(r => setTimeout(r, 350));

      const info = await page.evaluate(() => ({
        title: document.querySelector('#pageTitle').textContent,
        chars: document.querySelector('#body').innerText.length,
        skeletons: document.querySelectorAll('.skeleton').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      }));

      if (info.chars < 100) fail(view, `rendered only ${info.chars} chars`);
      if (info.overflow > 2) fail(view, `horizontal overflow of ${info.overflow}px`);
      pass(`${view} → "${info.title}" (${info.chars} chars)`);
    }

    // The live preview must show a real number, not a dash.
    await page.evaluate(() => document.querySelector('.side-link[data-view="pricing"]').click());
    await new Promise(r => setTimeout(r, 300));
    const price = await page.evaluate(() => {
      const n = document.querySelector('.pv-price');
      return n ? n.textContent.trim() : null;
    });
    if (!price || !/^\$[\d,]+/.test(price)) fail('pricing', `preview shows "${price}"`);
    else pass(`live preview shows ${price}`);

    // Editing the hourly rate must move it.
    const moved = await page.evaluate(() => {
      const before = document.querySelector('.pv-price').textContent;
      const input = document.querySelector('.card input[type=number]');
      input.value = String(parseFloat(input.value) * 2);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { before, after: document.querySelector('.pv-price').textContent };
    });
    if (moved.before === moved.after) fail('pricing', 'doubling the hourly rate did not change the preview');
    else pass(`rate edit repriced ${moved.before} → ${moved.after}`);

    // …and must flag the change as unsaved.
    const saveShown = await page.evaluate(() => !document.querySelector('#saveBtn').classList.contains('hidden'));
    if (!saveShown) fail('pricing', 'Save button stayed hidden after an edit');
    else pass('Save button appeared after edit');

    // Team-size editor, and the preview selects that go with it.
    const crewUi = await page.evaluate(() => ({
      rows: document.querySelectorAll('.erow.g-crew').length,
      labels: [...document.querySelectorAll('.pv-controls label')].map(l => l.textContent)
    }));
    if (crewUi.rows < 3) fail('pricing', `team-size editor showed ${crewUi.rows} row(s)`);
    else if (!crewUi.labels.includes('Team')) fail('pricing', 'preview has no Team select');
    else if (!crewUi.labels.includes('Language')) fail('pricing', 'preview has no Language select');
    else pass(`${crewUi.rows} team sizes editable, preview offers ${crewUi.labels.join(' / ')}`);

    // Switching the preview to Spanish must actually reprice in Spanish.
    const pvEs = await page.evaluate(() => {
      const sel = [...document.querySelectorAll('.pv-controls select')].find(s =>
        [...s.options].some(o => o.value === 'es'));
      if (!sel) return { missing: true };
      const before = document.querySelector('.pv-sub').textContent;
      const price = document.querySelector('.pv-price').textContent;
      sel.value = 'es';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        before, after: document.querySelector('.pv-sub').textContent,
        price, priceAfter: document.querySelector('.pv-price').textContent
      };
    });
    if (pvEs.missing) fail('pricing', 'no Spanish option in the preview language select');
    else if (pvEs.before === pvEs.after) fail('pricing', 'preview did not change language');
    else if (pvEs.price !== pvEs.priceAfter) {
      fail('pricing', `language changed the price ${pvEs.price} → ${pvEs.priceAfter}`);
    } else pass(`preview in Spanish: "${pvEs.after.trim()}"`);

    // The Spanish translation table on the branding view.
    await page.evaluate(() => document.querySelector('.side-link[data-view="branding"]').click());
    await new Promise(r => setTimeout(r, 300));
    const langTable = await page.evaluate(() => ({
      rows: document.querySelectorAll('.erow.g-lang').length,
      filled: [...document.querySelectorAll('.erow.g-lang input')].filter(i => i.value.trim()).length,
      counter: [...document.querySelectorAll('.hint')].map(h => h.textContent)
        .find(t => /translated/.test(t))
    }));
    if (langTable.rows < 10) fail('branding', `translation table had ${langTable.rows} row(s)`);
    else if (langTable.filled < langTable.rows) {
      fail('branding', `${langTable.rows - langTable.filled} preset lines have no Spanish`);
    } else pass(`translation table: ${langTable.counter || langTable.rows + ' rows'}`);

    // Mobile layout.
    await page.setViewport({ width: 390, height: 844 });
    await new Promise(r => setTimeout(r, 250));
    const mob = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (mob > 2) fail('mobile', `horizontal overflow of ${mob}px at 390px wide`);
    else pass('no horizontal overflow at 390px');

    await page.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} failure(s)\n` : '\nAll smoke checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
