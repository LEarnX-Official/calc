/**
 * Engine tests. Run: npm test
 * No framework — asserting arithmetic doesn't need one.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const E = require('../shared/engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { failed++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
}
function section(s) { console.log('\n\x1b[1m' + s + '\x1b[0m'); }

const cleaning = JSON.parse(fs.readFileSync(path.join(__dirname, '../verticals/residential-cleaning.json'), 'utf8'));
const lawn = JSON.parse(fs.readFileSync(path.join(__dirname, '../verticals/lawn-care.json'), 'utf8'));
const washing = JSON.parse(fs.readFileSync(path.join(__dirname, '../verticals/pressure-washing.json'), 'utf8'));

section('Core arithmetic');

test('prices a known job exactly', () => {
  // 1,400–1,799 sq ft = 120 min, 3 bed = 33, 2 full bath = 47, 0 half = 0  → 200 min
  // standard (×1), one time (no discount): 200/60 × $65 = $216.67
  const r = E.quote(cleaning, {
    size: 's3', modifiers: { bedrooms: 3, fullBaths: 2, halfBaths: 0 },
    service: 'standard', frequency: 'onetime', addons: {}
  });
  assert.strictEqual(r.baseMinutes, 200, 'baseMinutes should be 200, got ' + r.baseMinutes);
  // roundTo:1 → quotes land on whole dollars, so 216.67 presents as 217
  assert.strictEqual(r.total, 217, 'total should be 217, got ' + r.total);
  assert.ok(Math.abs(r.servicePrice - 217) < 1);
});

test('service multiplier scales both time and price', () => {
  const base = { size: 's3', modifiers: { bedrooms: 3, fullBaths: 2, halfBaths: 0 }, frequency: 'onetime', addons: {} };
  const std = E.quote(cleaning, { ...base, service: 'standard' });
  const deep = E.quote(cleaning, { ...base, service: 'deep' });
  assert.strictEqual(deep.serviceMinutes, std.serviceMinutes * 1.55);
  // tolerance = the rounding step on both operands
  assert.ok(Math.abs(deep.total - std.total * 1.55) < 2, 'deep should be ~1.55× standard');
});

test('frequency discount reduces the service price', () => {
  const base = { size: 's3', modifiers: { bedrooms: 3, fullBaths: 2, halfBaths: 0 }, service: 'standard', addons: {} };
  const once = E.quote(cleaning, { ...base, frequency: 'onetime' });
  const weekly = E.quote(cleaning, { ...base, frequency: 'weekly' });
  assert.ok(Math.abs(weekly.total - once.total * 0.8) < 2, '20% off expected');
  assert.ok(weekly.discountAmount > 0);
});

test('price factor scales the whole quote', () => {
  const input = { size: 's3', modifiers: { bedrooms: 3, fullBaths: 2, halfBaths: 0 }, service: 'standard', frequency: 'onetime', addons: {} };
  const a = E.quote(cleaning, input);
  const b = E.quote({ ...cleaning, priceFactor: 1.2 }, input);
  assert.ok(Math.abs(b.total - a.total * 1.2) < 2);
});

section('The minimum-price rule (the one people get wrong)');

test('minimum clamps the service subtotal', () => {
  // Smallest home, nothing else: 70 min → 70/60 × 65 = $75.83, below the $140 minimum
  const r = E.quote(cleaning, {
    size: 's0', modifiers: { bedrooms: 0, fullBaths: 0, halfBaths: 0 },
    service: 'standard', frequency: 'onetime', addons: {}
  });
  assert.strictEqual(r.minimumApplied, true);
  assert.strictEqual(r.servicePrice, 140);
  assert.strictEqual(r.total, 140);
});

test('add-ons stack ON TOP of the minimum, never swallowed by it', () => {
  const r = E.quote(cleaning, {
    size: 's0', modifiers: { bedrooms: 0, fullBaths: 0, halfBaths: 0 },
    service: 'standard', frequency: 'onetime', addons: { oven: 1 }
  });
  // $140 floor + $50 oven = $190, NOT $140
  assert.strictEqual(r.total, 190, 'expected 190, got ' + r.total);
  assert.strictEqual(r.addonsTotal, 50);
});

test('add-ons are not discounted by frequency', () => {
  const base = { size: 's4', modifiers: { bedrooms: 3, fullBaths: 2, halfBaths: 1 }, service: 'standard', addons: { oven: 1 } };
  const once = E.quote(cleaning, { ...base, frequency: 'onetime' });
  const weekly = E.quote(cleaning, { ...base, frequency: 'weekly' });
  assert.strictEqual(once.addonsTotal, 50);
  assert.strictEqual(weekly.addonsTotal, 50, 'add-on price must not change with frequency');
});

test('quantity add-ons multiply', () => {
  const r = E.quote(cleaning, {
    size: 's4', modifiers: { bedrooms: 3, fullBaths: 2, halfBaths: 0 },
    service: 'standard', frequency: 'onetime', addons: { windows: 8 }
  });
  assert.strictEqual(r.addonsTotal, 48, '8 windows × $6');
});

test('a flat add-on ignores quantity', () => {
  const base = {
    size: 's4', modifiers: { bedrooms: 3, fullBaths: 2, halfBaths: 0 },
    service: 'standard', frequency: 'onetime'
  };
  const one = E.quote(cleaning, { ...base, addons: { oven: 1 } });
  const forty = E.quote(cleaning, { ...base, addons: { oven: 40 } });
  assert.strictEqual(forty.addonsTotal, one.addonsTotal,
    'a tampered qty must not multiply a non-perUnit add-on');
  assert.strictEqual(forty.addonLines[0].qty, 1);
  assert.strictEqual(forty.serviceMinutes, one.serviceMinutes,
    'and it must not multiply the time estimate either');
});

test('a per-unit add-on is capped at 99', () => {
  const r = E.quote(cleaning, {
    size: 's4', modifiers: { bedrooms: 3, fullBaths: 2, halfBaths: 0 },
    service: 'standard', frequency: 'onetime', addons: { windows: 100000 }
  });
  assert.strictEqual(r.addonsTotal, 99 * 6);
});

section('Modifier curves');

test('curve is cumulative and tapers', () => {
  const mod = cleaning.modifiers.find(m => m.id === 'fullBaths');
  const one = E.modifierMinutes(mod, 1);
  const two = E.modifierMinutes(mod, 2);
  const three = E.modifierMinutes(mod, 3);
  assert.strictEqual(one, 25);
  assert.strictEqual(two, 47);
  assert.ok((two - one) < one, '2nd bathroom should cost less than the 1st');
  assert.ok((three - two) < (two - one), 'taper should continue');
});

test('quantities clamp to the configured max', () => {
  const a = E.quote(cleaning, { size: 's3', modifiers: { bedrooms: 99 }, service: 'standard', frequency: 'onetime' });
  const b = E.quote(cleaning, { size: 's3', modifiers: { bedrooms: 7 }, service: 'standard', frequency: 'onetime' });
  assert.strictEqual(a.total, b.total, 'over-max should clamp, not overflow');
});

test('flat minutesEach modifiers work (lawn care)', () => {
  const r = E.quote(lawn, { size: 'l2', modifiers: { trees: 4, beds: 0, gates: 0 }, service: 'mow', frequency: 'onetime' });
  assert.strictEqual(r.baseMinutes, 65 + 12, '4 trees × 3 min');
});

section('Custom-quote tiers');

test('custom tier short-circuits with a message', () => {
  const r = E.quote(cleaning, { size: 's10', modifiers: {}, service: 'standard', frequency: 'onetime' });
  assert.strictEqual(r.isCustom, true);
  assert.ok(r.message.length > 10);
  assert.strictEqual(r.total, 0);
});

section('Multi-vertical (same engine, different config)');

test('lawn care prices correctly', () => {
  // 1/4–1/2 acre = 65, 2 trees = 6, 2 beds = 16, 0 gates → 87 min
  // full service ×1.45 = 126.15 min → /60 × 70 = $147.18
  const r = E.quote(lawn, {
    size: 'l2', modifiers: { trees: 2, beds: 2, gates: 0 },
    service: 'full', frequency: 'onetime', addons: {}
  });
  assert.strictEqual(r.baseMinutes, 87);
  assert.strictEqual(r.total, 147, 'expected 147, got ' + r.total);
});

test('roundTo:5 rounds to the nearest five (pressure washing)', () => {
  const r = E.quote(washing, {
    size: 'p1', modifiers: { driveway: 2, walkway: 1, stories: 1 },
    service: 'standard', frequency: 'onetime', addons: {}
  });
  assert.strictEqual(r.total % 5, 0, 'total ' + r.total + ' should be a multiple of 5');
});

test('every shipped vertical passes its own validator', () => {
  [cleaning, lawn, washing].forEach(v => {
    const errs = E.validateConfig(v);
    assert.strictEqual(errs.length, 0, v.vertical + ': ' + errs.join('; '));
  });
});

section('Robustness');

test('never throws on garbage input', () => {
  assert.doesNotThrow(() => E.quote(cleaning, {}));
  assert.doesNotThrow(() => E.quote(cleaning, { size: 'nope', service: 'nope', frequency: 'nope' }));
  assert.doesNotThrow(() => E.quote(cleaning, null));
  assert.doesNotThrow(() => E.quote({}, {}));
  assert.doesNotThrow(() => E.quote(null, null));
});

test('unknown ids fall back to the first option', () => {
  const r = E.quote(cleaning, { size: 'bogus', modifiers: {}, service: 'bogus', frequency: 'bogus' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.total > 0);
});

test('empty config reports why instead of crashing', () => {
  const r = E.quote({}, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-size-tiers');
});

test('validator catches the revenue-losing mistakes', () => {
  assert.ok(E.validateConfig({ ...cleaning, hourlyRate: 0 }).length > 0, 'zero rate must fail');
  assert.ok(E.validateConfig({ ...cleaning, priceFactor: 0 }).length > 0, 'zero factor must fail');
  assert.ok(E.validateConfig({ ...cleaning, minimumPrice: -5 }).length > 0, 'negative minimum must fail');
  assert.ok(E.validateConfig({ ...cleaning, sizeTiers: [] }).length > 0, 'no tiers must fail');
  assert.ok(E.validateConfig({ ...cleaning, frequencies: [{ id: 'x', label: 'X', discount: 1.5 }] }).length > 0, '150% discount must fail');
});

section('Team sizes');

const JOB = { size: 's3', modifiers: { bedrooms: 3, fullBaths: 2, halfBaths: 0 }, service: 'standard', frequency: 'onetime', addons: {} };

test('a bigger team costs the same and finishes sooner', () => {
  // The whole design rests on this: crew size buys wall-clock, not revenue.
  const two = E.quote(cleaning, { ...JOB, crew: 'crew2' });
  const six = E.quote(cleaning, { ...JOB, crew: 'crew6' });
  assert.strictEqual(two.total, six.total, 'price must not move with crew size');
  assert.strictEqual(two.durationPerPerson, 100);
  assert.strictEqual(six.durationPerPerson, 33);
  assert.strictEqual(six.crewSize, 6);
  // durationMinutes is total crew-minutes and must NOT move — anything showing
  // it as "time on site" would make the picker look broken.
  assert.strictEqual(two.durationMinutes, six.durationMinutes);
});

test('a multiplier is the only thing that changes the price', () => {
  const cfg = { ...cleaning, crewOptions: [
    { id: 'crew2', size: 2, label: 'Team of 2', multiplier: 1 },
    { id: 'rush', size: 6, label: 'Rush crew', multiplier: 1.5 }
  ] };
  const normal = E.quote(cfg, { ...JOB, crew: 'crew2' });
  const rush = E.quote(cfg, { ...JOB, crew: 'rush' });
  // 200 min ÷ 60 × $65 = $216.67; ×1.5 = $325.00. Rounding happens once, at
  // the end — multiplying an already-rounded 217 would drift to $325.50.
  assert.strictEqual(normal.total, 217);
  assert.strictEqual(rush.total, 325);
  assert.strictEqual(rush.crewMultiplier, 1.5);
});

test('crewChoices offers every option priced and timed', () => {
  const r = E.quote(cleaning, JOB);
  assert.strictEqual(r.crewChoices.length, 3);
  assert.deepStrictEqual(r.crewChoices.map(o => o.onSiteMinutes), [100, 50, 33]);
  assert.ok(r.crewChoices.every(o => o.price === r.total), 'all options cost the same by default');
});

test('a config with no crewOptions still quotes exactly as before', () => {
  const legacy = { ...cleaning };
  delete legacy.crewOptions;
  delete legacy.defaultCrew;
  assert.strictEqual(E.quote(legacy, JOB).total, E.quote(cleaning, JOB).total);
  assert.strictEqual(E.quote(legacy, JOB).crewSize, legacy.crewSize);
});

test('defaultCrew decides where the calculator opens', () => {
  const cfg = { ...cleaning, defaultCrew: 'crew4' };
  assert.strictEqual(E.defaultInput(cfg).crew, 'crew4');
  assert.strictEqual(E.resolveCrew(cfg, 'nonsense').id, 'crew4');
});

test('validator rejects team sizes that would break a quote', () => {
  const bad = o => E.validateConfig({ ...cleaning, crewOptions: [o] }).length > 0;
  assert.ok(bad({ id: 'a', size: 0, label: 'Nobody' }), 'zero people must fail');
  assert.ok(bad({ id: 'a', size: 99, label: 'Army' }), 'over 20 must fail');
  assert.ok(bad({ id: 'a', size: 2, label: 'X', multiplier: 0 }), 'zero multiplier must fail');
  assert.ok(E.validateConfig({ ...cleaning, crewOptions: [] }).length > 0, 'empty list must fail');
  assert.ok(E.validateConfig({ ...cleaning,
    crewOptions: [{ id: 'a', size: 2, label: 'A' }, { id: 'a', size: 4, label: 'B' }] }).length > 0,
    'duplicate ids must fail');
});

section('Bilingual');

test('Spanish labels come through, English is untouched', () => {
  const en = E.quote(cleaning, JOB);
  const es = E.quote(cleaning, { ...JOB, lang: 'es' });
  assert.strictEqual(en.serviceLabel, 'Standard Clean');
  assert.strictEqual(es.serviceLabel, 'Limpieza Estándar');
  assert.strictEqual(es.frequencyLabel, 'Una sola vez');
  assert.strictEqual(es.crewLabel, 'Equipo de 2');
  assert.strictEqual(es.total, en.total, 'language must never move the price');
});

test('an untranslated field falls back to English rather than blank', () => {
  const cfg = { ...cleaning, services: cleaning.services.map(s => ({ ...s, labelEs: '' })) };
  assert.strictEqual(E.quote(cfg, { ...JOB, lang: 'es' }).serviceLabel, 'Standard Clean');
  assert.strictEqual(E.label({ label: 'Hi', labelEs: '   ' }, 'label', 'es'), 'Hi');
});

test('unknown languages degrade to English', () => {
  assert.strictEqual(E.normalizeLang('fr'), 'en');
  assert.strictEqual(E.normalizeLang('es-MX'), 'es');
  assert.strictEqual(E.normalizeLang(null), 'en');
  assert.strictEqual(E.quote(cleaning, { ...JOB, lang: 'fr' }).serviceLabel, 'Standard Clean');
});

test('Spanish is only offered when some exists', () => {
  assert.deepStrictEqual(E.availableLangs(cleaning), ['en', 'es']);
  const stripped = JSON.parse(JSON.stringify(cleaning), (k, v) => (k.slice(-2) === 'Es' ? undefined : v));
  assert.deepStrictEqual(E.availableLangs(stripped), ['en']);
  assert.deepStrictEqual(E.availableLangs({}), ['en']);
});

test('every shipped vertical is fully bilingual', () => {
  [cleaning, lawn, washing].forEach(v => {
    assert.deepStrictEqual(E.availableLangs(v), ['en', 'es'], v.vertical + ' needs Spanish');
    ['sizeTiers', 'services', 'frequencies', 'addons', 'modifiers', 'crewOptions'].forEach(key => {
      v[key].forEach(item => {
        assert.ok(item.labelEs, v.vertical + ' → ' + key + ' → "' + item.label + '" has no Spanish label');
      });
    });
  });
});

test('a custom tier explains itself in Spanish too', () => {
  const r = E.quote(cleaning, { ...JOB, size: 's10', lang: 'es' });
  assert.strictEqual(r.isCustom, true);
  assert.ok(/pies²/.test(r.message), 'expected the Spanish message, got: ' + r.message);
});

section('Formatting');

test('durations read naturally in Spanish', () => {
  assert.strictEqual(E.formatDuration(45, 'es'), '45 min');
  assert.strictEqual(E.formatDuration(60, 'es'), '1 hora');
  assert.strictEqual(E.formatDuration(120, 'es'), '2 horas');
  assert.strictEqual(E.formatDuration(135, 'es'), '2 h 15 min');
});

test('money formats with separators', () => {
  assert.strictEqual(E.formatMoney(1234.5, 'USD'), '$1,234.50');
  assert.strictEqual(E.formatMoney(99, 'GBP'), '£99.00');
});

test('duration is human readable', () => {
  assert.strictEqual(E.formatDuration(45), '45 min');
  assert.strictEqual(E.formatDuration(120), '2 hrs');
  assert.strictEqual(E.formatDuration(135), '2h 15m');
  assert.strictEqual(E.formatDuration(60), '1 hr');
});

console.log('\n' + (failed === 0
  ? `\x1b[32m${passed} passing\x1b[0m`
  : `\x1b[32m${passed} passing\x1b[0m, \x1b[31m${failed} failing\x1b[0m`) + '\n');
process.exit(failed === 0 ? 0 : 1);
