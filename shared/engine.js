/**
 * QuoteCraft pricing engine.
 *
 * Config-driven and vertical-agnostic: everything is expressed in MINUTES OF
 * CREW LABOUR, which is then priced at the tenant's hourly rate. A cleaning
 * company, a lawn crew and a pressure-washing outfit differ only in their
 * config file — never in this code.
 *
 * Order of operations (deliberate, and the order matters):
 *   1. base minutes  = size tier + every modifier
 *   2. × priceFactor (global thumb-on-the-scale, scales time AND money)
 *   3. × service multiplier (standard / deep / restorative ...)
 *   4. → price = minutes / 60 × hourlyRate
 *   5. × frequency multiplier (recurring discount)
 *   5b. × crew multiplier (usually 1 — see below)
 *   6. clamp to minimumPrice   ← service only
 *   7. + add-ons               ← stacked on top, never discounted, never clamped
 *
 * Step 6 before 7 is the one people get wrong. The minimum exists to cover the
 * cost of rolling a truck; it should not swallow a $60 oven clean the customer
 * explicitly asked for.
 *
 * CREW SIZE is deliberately not a price lever by default. The job is the same
 * number of crew-minutes whoever shows up; a team of 4 just finishes it in half
 * the time a team of 2 would. So the customer-facing effect is a shorter visit,
 * not a bigger bill. Operators who genuinely want to charge for a rush crew can
 * set a multiplier per option — but they have to choose it, because quietly
 * charging double for the same labour is how a calculator loses trust.
 *
 * BILINGUAL: any label-ish field `x` can have a sibling `xEs`. Nothing else in
 * the engine cares which language is in play — `label()` picks the translation
 * when one exists and falls back to the original when it doesn't, so a
 * half-translated config degrades to English rather than to blanks.
 *
 * UMD: runs in Node (server-side quote endpoint, tests) and the browser
 * (instant widget feedback) from one source of truth.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuoteEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function round(n, step) {
    if (!step || step <= 0) return Math.round(n * 100) / 100;
    return Math.round(n / step) * step;
  }

  function clampNum(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function findById(list, id) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  var LANGS = ['en', 'es'];

  /** 'es' or anything unrecognised → 'en'. One place to widen this later. */
  function normalizeLang(lang) {
    var l = String(lang || 'en').toLowerCase().slice(0, 2);
    return LANGS.indexOf(l) === -1 ? 'en' : l;
  }

  /**
   * The translated value of `field` on `obj`, or the original when there is no
   * translation. An empty string counts as "not translated" — an operator who
   * clears a Spanish box means "use the English", not "show nothing".
   */
  function label(obj, field, lang) {
    if (!obj) return '';
    if (normalizeLang(lang) === 'en') return obj[field] || '';
    var key = field + 'Es';
    var t = obj[key];
    return (t != null && String(t).trim()) ? t : (obj[field] || '');
  }

  /**
   * Crew options, normalised. A config that predates this feature has none, so
   * synthesise a single option from the old `crewSize` number and every quote
   * behaves exactly as it did before.
   */
  function crewOptions(config) {
    var list = (config && Array.isArray(config.crewOptions) ? config.crewOptions : [])
      .map(function (o) {
        var size = Math.max(1, Math.floor(Number(o.size) || 0));
        if (!size) return null;
        return {
          id: o.id || ('crew' + size),
          size: size,
          label: o.label || ('Team of ' + size),
          labelEs: o.labelEs || '',
          blurb: o.blurb || '',
          blurbEs: o.blurbEs || '',
          multiplier: Number(o.multiplier) > 0 ? Number(o.multiplier) : 1
        };
      })
      .filter(Boolean);
    if (list.length) return list;
    var fallback = Math.max(1, Number(config && config.crewSize) || 2);
    return [{
      id: 'crew' + fallback, size: fallback, label: 'Team of ' + fallback,
      labelEs: '', blurb: '', blurbEs: '', multiplier: 1
    }];
  }

  /** The option the customer picked, the configured default, or the first one. */
  function resolveCrew(config, wanted) {
    var opts = crewOptions(config);
    var picked = findById(opts, wanted);
    if (picked) return picked;
    var byDefault = findById(opts, config && config.defaultCrew);
    if (byDefault) return byDefault;
    // An older config's crewSize is still the most honest default when the
    // tenant has since added options but not said which one leads.
    var bySize = opts.filter(function (o) { return o.size === Number(config && config.crewSize); })[0];
    return bySize || opts[0];
  }

  /**
   * Minutes contributed by one modifier at a given quantity.
   *
   * `curve` is a cumulative lookup — curve[n] is the total minutes for n units,
   * letting the 4th bathroom cost less than the 1st (crews get set up once, and
   * a second bathroom reuses the same cart of chemicals). Falls back to a flat
   * per-unit rate when no curve is supplied.
   */
  function modifierMinutes(mod, qty) {
    var n = clampNum(qty | 0, mod.min != null ? mod.min : 0, mod.max != null ? mod.max : 99);
    if (Array.isArray(mod.curve) && mod.curve.length) {
      var idx = Math.min(n, mod.curve.length - 1);
      return mod.curve[idx] || 0;
    }
    return (mod.minutesEach || 0) * n;
  }

  /**
   * @param {object} config   tenant pricing config
   * @param {object} input    { size, modifiers:{id:qty}, service, frequency, addons:{id:qty}, crew, lang }
   * @returns {object} full breakdown — never throws on bad input, returns ok:false instead
   */
  function quote(config, input) {
    config = config || {};
    input = input || {};

    var lang = normalizeLang(input.lang);
    var hourlyRate = Number(config.hourlyRate) || 0;
    var priceFactor = Number(config.priceFactor) || 1;
    var minimumPrice = Number(config.minimumPrice) || 0;
    var roundTo = config.roundTo != null ? Number(config.roundTo) : 1;

    var crew = resolveCrew(config, input.crew);
    var crewSize = crew.size;
    var crewMult = crew.multiplier;

    var tier = findById(config.sizeTiers, input.size) || (config.sizeTiers || [])[0];
    if (!tier) return { ok: false, reason: 'no-size-tiers' };

    // Tiers can opt out of automatic pricing — the 12,000 sq ft estate, the
    // property with three outbuildings. Better an honest "let's talk" than a
    // confident number that loses money.
    if (tier.custom) {
      return {
        ok: true, isCustom: true, lang: lang,
        message: label(tier, 'customMessage', lang) ||
          (lang === 'es' ? 'Esta propiedad necesita un presupuesto personalizado.'
                         : 'This property needs a custom quote.'),
        lines: [], total: 0
      };
    }

    var service = findById(config.services, input.service) || (config.services || [])[0] || { multiplier: 1, label: '' };
    var frequency = findById(config.frequencies, input.frequency) || (config.frequencies || [])[0] || { discount: 0, label: '' };

    var serviceMult = Number(service.multiplier) || 1;
    var freqDiscount = clampNum(Number(frequency.discount) || 0, 0, 0.95);
    var freqMult = 1 - freqDiscount;

    // ── 1. accumulate minutes ────────────────────────────────────────────
    var lines = [];
    var baseMinutes = Number(tier.minutes) || 0;
    lines.push({ id: 'size', label: label(tier, 'label', lang), minutes: baseMinutes, kind: 'base' });

    var inputMods = input.modifiers || {};
    (config.modifiers || []).forEach(function (mod) {
      var qty = inputMods[mod.id] != null ? inputMods[mod.id] : (mod.default || 0);
      var mins = modifierMinutes(mod, qty);
      baseMinutes += mins;
      lines.push({ id: mod.id, label: label(mod, 'label', lang), qty: qty, minutes: mins, kind: 'modifier' });
    });

    // ── 2 & 3. scale ─────────────────────────────────────────────────────
    var scaledMinutes = baseMinutes * priceFactor;
    var serviceMinutes = scaledMinutes * serviceMult;

    // ── 4, 5 & 5b. price it ──────────────────────────────────────────────
    // crewMult is 1 unless the tenant has explicitly priced a bigger team
    // differently, so for almost everyone this line is a no-op.
    var grossPrice = (serviceMinutes / 60) * hourlyRate * crewMult;
    var discountedPrice = grossPrice * freqMult;
    var discountAmount = grossPrice - discountedPrice;

    // ── 6. minimum applies to the SERVICE only ───────────────────────────
    var servicePrice = Math.max(discountedPrice, minimumPrice);
    var minimumApplied = servicePrice > discountedPrice + 0.005;

    // ── 7. add-ons stack on top, undiscounted ────────────────────────────
    var addonsTotal = 0;
    var addonLines = [];
    var inputAddons = input.addons || {};
    (config.addons || []).forEach(function (addon) {
      var qty = Math.floor(Number(inputAddons[addon.id]) || 0);
      if (qty <= 0) return;
      // A flat add-on is on or off — clamp so a hand-edited request can't ask
      // for "inside oven × 40". Per-unit ones are capped at the same 99 the
      // widget's stepper enforces.
      qty = addon.perUnit ? Math.min(qty, 99) : 1;
      var price = (Number(addon.price) || 0) * qty;
      addonsTotal += price;
      addonLines.push({ id: addon.id, label: label(addon, 'label', lang), qty: qty, price: price });
      if (addon.minutes) serviceMinutes += Number(addon.minutes) * qty;
    });

    var total = servicePrice + addonsTotal;

    // Cost each way to run the job at the three recurring cadences, so the
    // widget can show "you'd save $X by going biweekly" without recomputing.
    var recurring = (config.frequencies || []).map(function (f) {
      var p = grossPrice * (1 - (Number(f.discount) || 0));
      return {
        id: f.id, label: label(f, 'label', lang),
        discount: Number(f.discount) || 0,
        price: round(Math.max(p, minimumPrice), roundTo)
      };
    });

    var displayMinutes = serviceMinutes * freqMult;

    // What the customer is actually choosing between: the same job, finished
    // in different amounts of wall-clock time.
    var crewChoices = crewOptions(config).map(function (o) {
      return {
        id: o.id, size: o.size,
        label: label(o, 'label', lang),
        blurb: label(o, 'blurb', lang),
        multiplier: o.multiplier,
        onSiteMinutes: Math.round(displayMinutes / o.size),
        price: round(Math.max(
          (serviceMinutes / 60) * hourlyRate * o.multiplier * freqMult, minimumPrice
        ) + addonsTotal, roundTo)
      };
    });

    return {
      ok: true,
      isCustom: false,
      lang: lang,
      currency: config.currency || 'USD',
      lines: lines,
      addonLines: addonLines,
      baseMinutes: baseMinutes,
      serviceMinutes: serviceMinutes,
      hourlyRate: hourlyRate,
      grossPrice: round(grossPrice, roundTo),
      discountAmount: round(discountAmount, roundTo),
      discountPercent: freqDiscount,
      servicePrice: round(servicePrice, roundTo),
      addonsTotal: round(addonsTotal, roundTo),
      minimumApplied: minimumApplied,
      minimumPrice: minimumPrice,
      total: round(total, roundTo),
      rangeLow: round(total, roundTo),
      rangeHigh: round(total + ((Number(config.rangeBufferMinutes) || 0) / 60) * hourlyRate, roundTo),
      priceFactor: priceFactor,
      serviceLabel: label(service, 'label', lang),
      frequencyLabel: label(frequency, 'label', lang),
      recurring: recurring,
      durationMinutes: Math.round(displayMinutes),
      durationPerPerson: Math.round(displayMinutes / crewSize),
      crewSize: crewSize,
      crewId: crew.id,
      crewLabel: label(crew, 'label', lang),
      crewMultiplier: crewMult,
      crewChoices: crewChoices
    };
  }

  function formatMoney(n, currency) {
    var symbols = { USD: '$', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$', NZD: 'NZ$' };
    var sym = symbols[currency] || '$';
    return sym + Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** `min`/`hr` read fine in English; Spanish needs its own short forms. */
  function formatDuration(mins, lang) {
    mins = Math.max(0, Math.round(mins || 0));
    var h = Math.floor(mins / 60), m = mins % 60;
    if (normalizeLang(lang) === 'es') {
      if (h === 0) return m + ' min';
      if (m === 0) return h + (h === 1 ? ' hora' : ' horas');
      return h + ' h ' + m + ' min';
    }
    if (h === 0) return m + ' min';
    if (m === 0) return h + (h === 1 ? ' hr' : ' hrs');
    return h + 'h ' + m + 'm';
  }

  /**
   * Guards the config editor. Bad pricing config is silent revenue loss —
   * an hourly rate of 0 quotes every job at the minimum and nobody notices
   * until the month's numbers come in.
   */
  function validateConfig(config) {
    var errors = [];
    if (!config || typeof config !== 'object') return ['Config must be an object.'];
    if (!(Number(config.hourlyRate) > 0)) errors.push('Hourly rate must be greater than 0.');
    if (Number(config.minimumPrice) < 0) errors.push('Minimum price cannot be negative.');
    var pf = Number(config.priceFactor);
    if (!(pf > 0.2 && pf < 5)) errors.push('Price factor must be between 0.2 and 5.');
    if (!Array.isArray(config.sizeTiers) || !config.sizeTiers.length) errors.push('At least one size tier is required.');
    if (!Array.isArray(config.services) || !config.services.length) errors.push('At least one service type is required.');
    if (!Array.isArray(config.frequencies) || !config.frequencies.length) errors.push('At least one frequency option is required.');

    (config.sizeTiers || []).forEach(function (t, i) {
      if (!t.id) errors.push('Size tier ' + (i + 1) + ' is missing an id.');
      if (!t.custom && !(Number(t.minutes) > 0)) errors.push('Size tier "' + (t.label || t.id) + '" needs minutes > 0.');
    });
    (config.services || []).forEach(function (s, i) {
      if (!s.id) errors.push('Service ' + (i + 1) + ' is missing an id.');
      if (!(Number(s.multiplier) > 0)) errors.push('Service "' + (s.label || s.id) + '" needs a multiplier > 0.');
    });
    (config.frequencies || []).forEach(function (f) {
      var d = Number(f.discount);
      if (!(d >= 0 && d < 1)) errors.push('Frequency "' + (f.label || f.id) + '" discount must be between 0 and 0.99.');
    });
    (config.addons || []).forEach(function (a, i) {
      if (!a.id) errors.push('Add-on ' + (i + 1) + ' is missing an id.');
      if (Number(a.price) < 0) errors.push('Add-on "' + (a.label || a.id) + '" cannot have a negative price.');
      if (Number(a.minutes) < 0) errors.push('Add-on "' + (a.label || a.id) + '" cannot have negative minutes.');
      if (a.perUnit != null && typeof a.perUnit !== 'boolean') {
        errors.push('Add-on "' + (a.label || a.id) + '" has an invalid per-unit setting.');
      }
    });

    // crewOptions is optional — absent means "one crew, the old crewSize".
    if (config.crewOptions != null) {
      if (!Array.isArray(config.crewOptions) || !config.crewOptions.length) {
        errors.push('Add at least one team size, or remove them all to use a single crew.');
      } else {
        var seen = {};
        config.crewOptions.forEach(function (o, i) {
          var name = (o && (o.label || o.id)) || ('Team size ' + (i + 1));
          if (!o || !o.id) errors.push('Team size ' + (i + 1) + ' is missing an id.');
          if (!(Number(o && o.size) >= 1)) errors.push('"' + name + '" needs at least 1 person.');
          if (Number(o && o.size) > 20) errors.push('"' + name + '" is larger than 20 people.');
          if (o && o.multiplier != null && !(Number(o.multiplier) > 0 && Number(o.multiplier) < 5)) {
            errors.push('"' + name + '" needs a price multiplier between 0 and 5.');
          }
          if (o && o.id) {
            if (seen[o.id]) errors.push('Two team sizes share the id "' + o.id + '".');
            seen[o.id] = true;
          }
        });
      }
    }
    return errors;
  }

  /**
   * Which languages this config can actually serve. English is always in;
   * Spanish only counts once something has been translated, so a tenant who
   * hasn't written any Spanish never shows customers a toggle that does
   * nothing.
   */
  function availableLangs(config) {
    var langs = ['en'];
    if (hasSpanish(config)) langs.push('es');
    return langs;
  }

  function hasSpanish(config) {
    if (!config) return false;
    var filled = function (v) { return v != null && String(v).trim() !== ''; };
    if (filled(config.sizeLabelEs)) return true;
    var lists = ['sizeTiers', 'modifiers', 'services', 'frequencies', 'addons', 'crewOptions'];
    for (var i = 0; i < lists.length; i++) {
      var list = config[lists[i]];
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) {
        var item = list[j] || {};
        for (var k in item) {
          if (Object.prototype.hasOwnProperty.call(item, k) &&
              k.slice(-2) === 'Es' && filled(item[k])) return true;
        }
      }
    }
    return false;
  }

  /** Defaults for the widget's initial render — first tier, first service, cheapest-commitment frequency. */
  function defaultInput(config, lang) {
    config = config || {};
    var mods = {};
    (config.modifiers || []).forEach(function (m) { mods[m.id] = m.default || 0; });
    var tiers = config.sizeTiers || [];
    var mid = tiers.length ? tiers[Math.min(Math.floor(tiers.length / 3), tiers.length - 1)] : null;
    return {
      size: mid ? mid.id : null,
      modifiers: mods,
      service: (config.services || [])[0] ? config.services[0].id : null,
      frequency: (config.frequencies || [])[0] ? config.frequencies[0].id : null,
      addons: {},
      crew: resolveCrew(config, config.defaultCrew).id,
      lang: normalizeLang(lang)
    };
  }

  return {
    quote: quote,
    validateConfig: validateConfig,
    defaultInput: defaultInput,
    formatMoney: formatMoney,
    formatDuration: formatDuration,
    modifierMinutes: modifierMinutes,
    label: label,
    normalizeLang: normalizeLang,
    availableLangs: availableLangs,
    crewOptions: crewOptions,
    resolveCrew: resolveCrew,
    LANGS: LANGS
  };
});
