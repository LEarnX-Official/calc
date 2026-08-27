/**
 * The customer-facing calculator.
 *
 * Renders entirely from the tenant's config — this file knows nothing about
 * cleaning, lawns or pressure washing. Prices update locally for instant
 * feedback; the number that gets stored with a lead is always recomputed
 * server-side, so a customer editing JS in devtools can't book at $1.
 */
(function () {
  'use strict';

  var SLUG = location.pathname.split('/').filter(Boolean).pop();
  var E = window.QuoteEngine;
  var root = document.getElementById('root');

  var cfg = null, branding = null, businessName = '', input = null;
  var stage = 'calc'; // calc | lead | thanks
  var lang = 'en', langs = ['en'];

  /* ── strings ───────────────────────────────────────────────────────────
     The widget's own chrome. Anything the *tenant* wrote (service names,
     add-ons, headline) is translated in their config instead — see
     QuoteEngine.label. Keep both halves in sync or a Spanish customer gets a
     Spanish button above an English service list. */
  var STR = {
    en: {
      propertyDetails: 'Property details', propertySub: 'Tell us about the property.',
      size: 'Size',
      serviceType: 'Service type', serviceSub: 'What kind of visit do you need?',
      howOften: 'How often?', howOftenSub: 'Regular visits cost less per clean.',
      oneTimeOnly: 'is a one-time visit.',
      teamSize: 'How big a team?',
      teamSub: 'Same job either way — a bigger crew just finishes sooner.',
      teamSubPriced: 'A bigger crew finishes sooner. Prices shown per option.',
      anythingElse: 'Anything else?', anythingElseSub: 'Optional extras, priced per visit.',
      each: ' ea', save: 'SAVE', standardPrice: 'Standard price',
      estimate: 'Your estimate', custom: 'Custom', customQuote: 'Custom quote',
      discount: 'discount',
      minimumNote: 'Our minimum call-out applies to this job.',
      included: "What's included", totalLabel: 'Total',
      otherSchedules: 'Other schedules',
      timeOnSite: 'Estimated time on site',
      teamOf: 'team of', crewTime: 'of crew time',
      requestQuote: 'Request a quote', emailQuote: 'Email me this quote',
      backToCalc: 'Back to the calculator',
      yourName: 'Your name', phone: 'Phone', email: 'Email',
      address: 'Service address', anythingKnow: 'Anything we should know?',
      namePh: 'Jane Doe', phonePh: '(555) 123-4567', emailPh: 'jane@example.com',
      addressPh: '18 Alder Court', notePh: 'Parking, pets, access instructions, preferred days…',
      emailHint: "We'll send a copy of this quote and follow up to confirm.",
      sendQuote: 'Send my quote', sending: 'Sending…',
      noObligation: "No obligation. We'll only use your details to contact you about this job.",
      companyWebsite: 'Company website',
      quoteSent: 'Quote sent',
      thanksDefault: "Thanks — we'll be in touch shortly.",
      startAnother: 'Start another quote',
      unavailable: 'Calculator unavailable',
      unavailableBody: "We couldn't load this pricing calculator. Please refresh, or contact us directly.",
      needContact: 'Please add an email or phone number so we can reach you.',
      badEmail: "That email address doesn't look right.",
      sendFailed: 'Could not send. Please try again.',
      poweredBy: 'Powered by', switchTo: 'Ver en español'
    },
    es: {
      propertyDetails: 'Datos de la propiedad', propertySub: 'Cuéntanos sobre la propiedad.',
      size: 'Tamaño',
      serviceType: 'Tipo de servicio', serviceSub: '¿Qué tipo de visita necesitas?',
      howOften: '¿Con qué frecuencia?', howOftenSub: 'Las visitas regulares cuestan menos por limpieza.',
      oneTimeOnly: 'es una visita única.',
      teamSize: '¿De qué tamaño el equipo?',
      teamSub: 'Es el mismo trabajo — un equipo más grande solo termina antes.',
      teamSubPriced: 'Un equipo más grande termina antes. Precio por opción.',
      anythingElse: '¿Algo más?', anythingElseSub: 'Extras opcionales, por visita.',
      each: ' c/u', save: 'AHORRA', standardPrice: 'Precio normal',
      estimate: 'Tu presupuesto', custom: 'A medida', customQuote: 'Presupuesto a medida',
      discount: 'de descuento',
      minimumNote: 'A este trabajo le aplica nuestro cargo mínimo por visita.',
      included: 'Qué incluye', totalLabel: 'Total',
      otherSchedules: 'Otras frecuencias',
      timeOnSite: 'Tiempo estimado en sitio',
      teamOf: 'equipo de', crewTime: 'de trabajo en total',
      requestQuote: 'Solicitar presupuesto', emailQuote: 'Envíenme este presupuesto',
      backToCalc: 'Volver a la calculadora',
      yourName: 'Tu nombre', phone: 'Teléfono', email: 'Correo electrónico',
      address: 'Dirección del servicio', anythingKnow: '¿Algo que debamos saber?',
      namePh: 'María García', phonePh: '(555) 123-4567', emailPh: 'maria@ejemplo.com',
      addressPh: 'Calle Alder 18', notePh: 'Estacionamiento, mascotas, cómo entrar, días preferidos…',
      emailHint: 'Te enviamos una copia del presupuesto y te contactamos para confirmar.',
      sendQuote: 'Enviar mi presupuesto', sending: 'Enviando…',
      noObligation: 'Sin compromiso. Solo usamos tus datos para contactarte sobre este trabajo.',
      companyWebsite: 'Sitio web de la empresa',
      quoteSent: 'Presupuesto enviado',
      thanksDefault: 'Gracias — te contactamos muy pronto.',
      startAnother: 'Hacer otro presupuesto',
      unavailable: 'Calculadora no disponible',
      unavailableBody: 'No pudimos cargar esta calculadora. Actualiza la página o contáctanos directamente.',
      needContact: 'Agrega un correo o teléfono para poder contactarte.',
      badEmail: 'Ese correo electrónico no parece correcto.',
      sendFailed: 'No se pudo enviar. Inténtalo de nuevo.',
      poweredBy: 'Con tecnología de', switchTo: 'View in English'
    }
  };
  function t(key) { return (STR[lang] && STR[lang][key]) || STR.en[key] || ''; }
  /** Tenant-authored text, in the current language, falling back to English. */
  function tl(obj, field) { return E.label(obj, field, lang); }

  var LANG_KEY = 'quotecraft:lang:' + SLUG;

  /**
   * Remembered choice wins; otherwise take the browser's hint. A Spanish
   * speaker landing on an English page shouldn't have to find the toggle.
   */
  function initialLang(available) {
    try {
      var saved = localStorage.getItem(LANG_KEY);
      if (saved && available.indexOf(saved) !== -1) return saved;
    } catch (_) {}
    var nav = (navigator.languages || [navigator.language || 'en']);
    for (var i = 0; i < nav.length; i++) {
      var code = String(nav[i] || '').toLowerCase().slice(0, 2);
      if (available.indexOf(code) !== -1) return code;
    }
    return available[0] || 'en';
  }

  function setLang(next) {
    lang = E.normalizeLang(next);
    input.lang = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch (_) {}
    document.documentElement.lang = lang;
    render();
  }

  /* ── icons ─────────────────────────────────────────────────────────── */
  var ICONS = {
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    beaker: '<path d="M9 3h6M10 3v6L5 19a2 2 0 001.8 2h10.4A2 2 0 0019 19l-5-10V3"/>',
    box: '<path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8"/>',
    leaf: '<path d="M11 20A7 7 0 019 6c4-2 8-2 11-1 1 3 1 7-1 11a7 7 0 01-8 4zM4 20c2-4 5-7 9-9"/>',
    droplet: '<path d="M12 2.7l5 6.3a6.5 6.5 0 11-10 0z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    clock: '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/>',
    users: '<path d="M16 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="3.2"/>' +
           '<path d="M22 20v-2a4 4 0 00-3-3.87M16.5 4.2a4 4 0 010 5.6"/>'
  };
  function icon(name, cls) {
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.sparkle) + '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg, kind) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    setTimeout(function () { t.className = 'toast ' + (kind || ''); }, 2600);
  }

  /** Tell the parent page how tall we are so the iframe can grow with us. */
  var lastH = 0;
  function postHeight() {
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(h - lastH) < 2) return;
    lastH = h;
    try { parent.postMessage({ type: 'quotecraft:height', slug: SLUG, height: h }, '*'); } catch (_) {}
  }
  setInterval(postHeight, 400);
  window.addEventListener('resize', postHeight);

  /* ── boot ──────────────────────────────────────────────────────────── */
  fetch('/api/public/config/' + encodeURIComponent(SLUG))
    .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
    .then(function (d) {
      cfg = d.config; branding = d.branding; businessName = d.businessName;

      // Only offer languages the tenant has actually written copy for, and
      // only if they haven't switched the toggle off.
      langs = E.availableLangs(cfg);
      if (branding.showLanguageToggle === false) langs = ['en'];
      lang = initialLang(langs);
      document.documentElement.lang = lang;

      input = E.defaultInput(cfg, lang);
      if (branding.accent) applyAccent(branding.accent);
      render();
    })
    .catch(function () {
      root.innerHTML = '<div class="empty"><h4>' + esc(t('unavailable')) + '</h4>' +
        '<p>' + esc(t('unavailableBody')) + '</p></div>';
    });

  /** Tenants pick an accent; recolour the panel gradient and primary controls. */
  function applyAccent(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
    var s = document.documentElement.style;
    s.setProperty('--violet-600', hex);
    s.setProperty('--violet-700', shade(hex, -0.22));
    s.setProperty('--violet-500', shade(hex, 0.14));
    s.setProperty('--violet-300', shade(hex, 0.42));
    s.setProperty('--violet-100', shade(hex, 0.84));
    s.setProperty('--violet-050', shade(hex, 0.93));
  }
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (amt > 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
    else { r *= (1 + amt); g *= (1 + amt); b *= (1 + amt); }
    return '#' + [r, g, b].map(function (v) {
      return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2);
    }).join('');
  }

  /* ── render ────────────────────────────────────────────────────────── */
  /**
   * A two-state toggle rather than a dropdown: with two languages, a dropdown
   * costs a click to discover what's even in it, and the label of the *other*
   * language is the clearest possible affordance.
   */
  function langToggle() {
    if (langs.length < 2) return '';
    return '<div class="lang-switch">' +
      langs.map(function (code) {
        return '<button type="button" class="lang-btn' + (code === lang ? ' active' : '') +
          '" data-lang="' + code + '" lang="' + code + '"' +
          (code === lang ? ' aria-current="true"' : '') + '>' +
          (code === 'es' ? 'Español' : 'English') + '</button>';
      }).join('') + '</div>';
  }

  function render() {
    if (stage === 'thanks') return renderThanks();
    var q = E.quote(cfg, input);
    root.innerHTML =
      '<div class="qw-head">' +
        '<div class="qw-head-txt">' +
          '<h2>' + esc(tl(branding, 'headline') || t('estimate')) + '</h2>' +
          '<p>' + esc(tl(branding, 'subhead')) + '</p>' +
        '</div>' +
        langToggle() +
      '</div>' +
      '<div class="qw-grid">' +
        '<div>' + (stage === 'lead' ? leadForm(q) : calcCards(q)) + '</div>' +
        '<div>' + panel(q) + '</div>' +
      '</div>' +
      '<div class="powered">' + esc(t('poweredBy')) +
        ' <a href="/" target="_blank" rel="noopener">QuoteCraft</a></div>';
    wire();
    postHeight();
  }

  function calcCards(q) {
    var html = '';
    var sizeLabel = tl(cfg, 'sizeLabel');

    // Size + modifiers
    html += '<div class="qw-card">' +
      '<div class="qw-card-head"><div class="icon-tile">' + icon('box') + '</div>' +
      '<div><h3>' + esc(sizeLabel || t('propertyDetails')) + '</h3>' +
      '<div class="sub">' + esc(t('propertySub')) + '</div></div></div>' +
      '<div class="field"><label>' + esc(sizeLabel || t('size')) + '</label><select id="selSize">' +
      (cfg.sizeTiers || []).map(function (tier) {
        return '<option value="' + esc(tier.id) + '"' + (tier.id === input.size ? ' selected' : '') +
          '>' + esc(tl(tier, 'label')) + '</option>';
      }).join('') + '</select></div>';

    (cfg.modifiers || []).forEach(function (m) {
      var v = input.modifiers[m.id] || 0;
      var help = tl(m, 'help');
      html += '<div class="mod-row"><div><div class="m-label">' + esc(tl(m, 'label')) + '</div>' +
        (help ? '<div class="m-help">' + esc(help) + '</div>' : '') + '</div>' +
        '<div class="stepper">' +
        '<button data-mod="' + esc(m.id) + '" data-d="-1"' + (v <= (m.min || 0) ? ' disabled' : '') + '>−</button>' +
        '<div class="val">' + v + '</div>' +
        '<button data-mod="' + esc(m.id) + '" data-d="1"' + (v >= (m.max != null ? m.max : 99) ? ' disabled' : '') + '>+</button>' +
        '</div></div>';
    });
    html += '</div>';

    // Service type
    html += '<div class="qw-card">' +
      '<div class="qw-card-head"><div class="icon-tile apricot">' + icon('sparkle') + '</div>' +
      '<div><h3>' + esc(t('serviceType')) + '</h3><div class="sub">' + esc(t('serviceSub')) + '</div></div></div>' +
      '<div class="grid-3">' +
      (cfg.services || []).map(function (s) {
        return '<div class="choice' + (s.id === input.service ? ' active' : '') + '" data-service="' + esc(s.id) + '">' +
          '<div class="c-icon">' + icon(s.icon) + '</div>' +
          '<div class="c-name">' + esc(tl(s, 'label')) + '</div>' +
          '<div class="c-sub">' + esc(tl(s, 'blurb')) + '</div></div>';
      }).join('') + '</div></div>';

    // Frequency — only meaningful when the chosen service allows recurring
    var svc = (cfg.services || []).filter(function (s) { return s.id === input.service; })[0] || {};
    var canRecur = svc.allowRecurring !== false;
    html += '<div class="qw-card">' +
      '<div class="qw-card-head"><div class="icon-tile sage">' + icon('clock') + '</div>' +
      '<div><h3>' + esc(t('howOften')) + '</h3><div class="sub">' +
      (canRecur ? esc(t('howOftenSub'))
                : esc(tl(svc, 'label')) + ' ' + esc(t('oneTimeOnly'))) +
      '</div></div></div>' +
      '<div class="grid-4">' +
      (cfg.frequencies || []).map(function (f) {
        var isOnce = (Number(f.discount) || 0) === 0;
        var disabled = !canRecur && !isOnce;
        return '<div class="choice' + (f.id === input.frequency ? ' active' : '') + (disabled ? ' disabled' : '') +
          '" data-freq="' + esc(f.id) + '">' +
          '<div class="c-name">' + esc(tl(f, 'label')) + '</div>' +
          (f.discount > 0
            ? '<div class="c-tag">' + esc(t('save')) + ' ' + Math.round(f.discount * 100) + '%</div>'
            : '<div class="c-sub">' + esc(t('standardPrice')) + '</div>') +
          '</div>';
      }).join('') + '</div></div>';

    // Team size — only worth asking when there's more than one answer.
    var crews = (q && q.crewChoices) || [];
    if (crews.length > 1) {
      // If every option costs the same (the usual case) don't print a price on
      // each tile — repeating one number three times just invites the question
      // "so what am I paying extra for?"
      var priced = crews.some(function (o) { return o.multiplier !== crews[0].multiplier; });
      html += '<div class="qw-card">' +
        '<div class="qw-card-head"><div class="icon-tile">' + icon('users') + '</div>' +
        '<div><h3>' + esc(t('teamSize')) + '</h3><div class="sub">' +
        esc(priced ? t('teamSubPriced') : t('teamSub')) + '</div></div></div>' +
        '<div class="grid-3">' +
        crews.map(function (o) {
          return '<div class="choice' + (o.id === input.crew ? ' active' : '') +
            '" data-crew="' + esc(o.id) + '">' +
            '<div class="c-name">' + esc(o.label) + '</div>' +
            '<div class="c-sub">' + esc(o.blurb) + '</div>' +
            '<div class="c-tag quiet">' + esc(E.formatDuration(o.onSiteMinutes, lang)) +
              (priced ? ' · ' + esc(E.formatMoney(o.price, cfg.currency).replace(/\.00$/, '')) : '') +
            '</div></div>';
        }).join('') + '</div></div>';
    }

    // Add-ons
    if ((cfg.addons || []).length) {
      html += '<div class="qw-card">' +
        '<div class="qw-card-head"><div class="icon-tile clay">' + icon('sparkle') + '</div>' +
        '<div><h3>' + esc(t('anythingElse')) + '</h3>' +
        '<div class="sub">' + esc(t('anythingElseSub')) + '</div></div></div>';
      (cfg.addons || []).forEach(function (a) {
        var qty = input.addons[a.id] || 0;
        html += '<div class="addon-row' + (qty > 0 ? ' checked' : '') + '" data-addon="' + esc(a.id) + '">' +
          '<div class="box">' + icon('check') + '</div>' +
          '<div class="a-name">' + esc(tl(a, 'label')) + '</div>' +
          (a.perUnit && qty > 0 ?
            '<div class="stepper"><button data-aq="' + esc(a.id) + '" data-d="-1">−</button>' +
            '<div class="val">' + qty + '</div>' +
            '<button data-aq="' + esc(a.id) + '" data-d="1">+</button></div>' : '') +
          '<div class="a-price">' + E.formatMoney(a.price, cfg.currency) +
            (a.perUnit ? esc(t('each')) : '') + '</div></div>';
      });
      html += '</div>';
    }
    return html;
  }

  function panel(q) {
    if (!q.ok) return '<div class="qw-panel"><div class="qp-eyebrow">' + esc(t('estimate')) +
      '</div><div class="qp-price">—</div></div>';

    var html = '<div class="qw-panel"><div class="qp-eyebrow">' + esc(t('estimate')) + '</div>';

    if (q.isCustom) {
      html += '<div class="qp-price" style="font-size:34px">' + esc(t('custom')) + '</div>' +
        '<div class="qp-custom" style="display:block">' + esc(q.message) + '</div>' +
        '<button class="btn btn-accent btn-block qp-cta" id="btnLead">' +
        esc(tl(branding, 'ctaLabel') || t('requestQuote')) + '</button></div>';
      return html;
    }

    var showRange = branding.showRange && q.rangeHigh > q.total;
    html += '<div class="qp-price' + (showRange ? ' range' : '') + '" id="price">' +
      (showRange
        ? E.formatMoney(q.rangeLow, q.currency) + ' – ' + E.formatMoney(q.rangeHigh, q.currency)
        : E.formatMoney(q.total, q.currency)) + '</div>';

    if (q.minimumApplied) html += '<div class="qp-note show">' + esc(t('minimumNote')) + '</div>';
    html += '<div class="qp-badge">' + esc(q.serviceLabel) + ' · ' + esc(q.frequencyLabel) + '</div>';

    html += '<div class="qp-sec"><div class="qp-sec-t">' + esc(t('included')) + '</div>';
    q.lines.forEach(function (l) {
      if (!l.minutes) return;
      html += '<div class="qp-line"><span>' + esc(l.label) + (l.qty ? ' (' + l.qty + ')' : '') +
        '</span><span class="v">' + E.formatDuration(l.minutes, lang) + '</span></div>';
    });
    if (q.discountAmount > 0) {
      html += '<div class="qp-line disc"><span>' + esc(q.frequencyLabel) + ' ' + esc(t('discount')) + '</span>' +
        '<span class="v">− ' + E.formatMoney(q.discountAmount, q.currency) + '</span></div>';
    }
    (q.addonLines || []).forEach(function (a) {
      html += '<div class="qp-line"><span>' + esc(a.label) + (a.qty > 1 ? ' ×' + a.qty : '') +
        '</span><span class="v">' + E.formatMoney(a.price, q.currency) + '</span></div>';
    });
    html += '<div class="qp-line total"><span>' + esc(t('totalLabel')) + '</span><span class="v">' +
      E.formatMoney(q.total, q.currency) + '</span></div></div>';

    if (branding.showRecurring && (q.recurring || []).length > 1) {
      var cheapest = q.recurring.reduce(function (a, b) { return b.price < a.price ? b : a; });
      html += '<div class="qp-sec"><div class="qp-sec-t">' + esc(t('otherSchedules')) + '</div>';
      q.recurring.forEach(function (r) {
        html += '<div class="qp-line' + (r.id === cheapest.id ? ' best' : '') + '"><span>' + esc(r.label) +
          '</span><span class="v">' + E.formatMoney(r.price, q.currency) + '</span></div>';
      });
      html += '</div>';
    }

    if (branding.showDuration) {
      // The headline number is wall-clock — how long the van is outside — not
      // total crew-minutes. They're the same only for a crew of one, and
      // showing the total would mean picking a bigger team never moves it.
      html += '<div class="qp-time"><div class="t-l">' + esc(t('timeOnSite')) + '</div>' +
        '<div class="t-v">' + E.formatDuration(q.durationPerPerson, lang) + '</div>' +
        '<div class="t-s">' + esc(t('teamOf')) + ' ' + q.crewSize + ' · ' +
        E.formatDuration(q.durationMinutes, lang) + ' ' + esc(t('crewTime')) + '</div></div>';
    }

    html += '<button class="btn btn-accent btn-block qp-cta" id="btnLead">' +
      esc(tl(branding, 'ctaLabel') || t('emailQuote')) + '</button></div>';
    return html;
  }

  function leadForm(q) {
    var priceText = q.isCustom ? t('customQuote') : E.formatMoney(q.total, q.currency);
    return '<div class="qw-card lead-panel open">' +
      '<button class="lead-back" id="btnBack">' + icon('back') + ' ' + esc(t('backToCalc')) + '</button>' +
      '<div class="lead-summary"><div><div class="ls-l">' + esc(t('estimate')) + '</div>' +
      '<div class="ls-v">' + priceText + '</div></div>' +
      '<div class="badge">' + esc(q.serviceLabel || '') + '</div></div>' +
      '<div class="field-row">' +
        '<div class="field"><label>' + esc(t('yourName')) + '</label><input type="text" id="lName" placeholder="' + esc(t('namePh')) + '" autocomplete="name"/></div>' +
        '<div class="field"><label>' + esc(t('phone')) + '</label><input type="tel" id="lPhone" placeholder="' + esc(t('phonePh')) + '" autocomplete="tel"/></div>' +
      '</div>' +
      '<div class="field"><label>' + esc(t('email')) + '</label><input type="email" id="lEmail" placeholder="' + esc(t('emailPh')) + '" autocomplete="email"/>' +
      '<div class="hint">' + esc(t('emailHint')) + '</div></div>' +
      '<div class="field"><label>' + esc(t('address')) + '</label><input type="text" id="lAddress" placeholder="' + esc(t('addressPh')) + '" autocomplete="street-address"/></div>' +
      '<div class="field"><label>' + esc(t('anythingKnow')) + '</label>' +
      '<textarea id="lNote" placeholder="' + esc(t('notePh')) + '"></textarea></div>' +
      // Honeypot — real people never see it, bots fill it in.
      '<div style="position:absolute;left:-9999px" aria-hidden="true">' +
      '<label>' + esc(t('companyWebsite')) + '</label><input type="text" id="lHoney" tabindex="-1" autocomplete="off"/></div>' +
      '<button class="btn btn-accent btn-block btn-lg" id="btnSubmit">' + esc(t('sendQuote')) + '</button>' +
      '<div class="hint" style="text-align:center;margin-top:12px">' +
      esc(t('noObligation')) + '</div></div>';
  }

  function renderThanks() {
    root.innerHTML = '<div class="qw-card thanks">' +
      '<div class="icon-tile">' + icon('check') + '</div>' +
      '<h3>' + esc(t('quoteSent')) + '</h3>' +
      '<p>' + esc(tl(branding, 'thanksMessage') || t('thanksDefault')) + '</p>' +
      '<button class="btn btn-outline" id="btnRestart" style="margin-top:22px">' +
      esc(t('startAnother')) + '</button></div>' +
      '<div class="powered">' + esc(t('poweredBy')) +
      ' <a href="/" target="_blank" rel="noopener">QuoteCraft</a></div>';
    document.getElementById('btnRestart').addEventListener('click', function () {
      input = E.defaultInput(cfg, lang); stage = 'calc'; render();
    });
    postHeight();
  }

  /* ── events ────────────────────────────────────────────────────────── */
  function flash() {
    var p = document.getElementById('price');
    if (!p) return;
    p.classList.add('flash');
    setTimeout(function () { p.classList.remove('flash'); }, 130);
  }

  function wire() {
    var sel = document.getElementById('selSize');
    if (sel) sel.addEventListener('change', function () { input.size = sel.value; flash(); render(); });

    document.querySelectorAll('[data-lang]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.lang !== lang) setLang(b.dataset.lang);
      });
    });

    document.querySelectorAll('[data-crew]').forEach(function (c) {
      c.addEventListener('click', function () {
        input.crew = c.dataset.crew; flash(); render();
      });
    });

    document.querySelectorAll('[data-mod]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = (cfg.modifiers || []).filter(function (x) { return x.id === b.dataset.mod; })[0];
        if (!m) return;
        var cur = input.modifiers[m.id] || 0;
        var next = cur + parseInt(b.dataset.d, 10);
        input.modifiers[m.id] = Math.max(m.min || 0, Math.min(m.max != null ? m.max : 99, next));
        flash(); render();
      });
    });

    document.querySelectorAll('[data-service]').forEach(function (c) {
      c.addEventListener('click', function () {
        input.service = c.dataset.service;
        var svc = (cfg.services || []).filter(function (s) { return s.id === input.service; })[0] || {};
        // Snap to a one-time frequency when the service can't recur, so the
        // customer never sees a weekly deep-clean discount they can't have.
        if (svc.allowRecurring === false) {
          var once = (cfg.frequencies || []).filter(function (f) { return !f.discount; })[0];
          if (once) input.frequency = once.id;
        }
        flash(); render();
      });
    });

    document.querySelectorAll('[data-freq]').forEach(function (c) {
      c.addEventListener('click', function () {
        if (c.classList.contains('disabled')) return;
        input.frequency = c.dataset.freq; flash(); render();
      });
    });

    document.querySelectorAll('[data-addon]').forEach(function (r) {
      r.addEventListener('click', function (ev) {
        if (ev.target.closest('[data-aq]')) return;
        var id = r.dataset.addon;
        input.addons[id] = (input.addons[id] || 0) > 0 ? 0 : 1;
        flash(); render();
      });
    });
    document.querySelectorAll('[data-aq]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var id = b.dataset.aq;
        var next = (input.addons[id] || 0) + parseInt(b.dataset.d, 10);
        input.addons[id] = Math.max(0, Math.min(99, next));
        flash(); render();
      });
    });

    var lead = document.getElementById('btnLead');
    if (lead) lead.addEventListener('click', function () {
      stage = 'lead'; render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    var back = document.getElementById('btnBack');
    if (back) back.addEventListener('click', function () { stage = 'calc'; render(); });

    var submit = document.getElementById('btnSubmit');
    if (submit) submit.addEventListener('click', sendLead);
  }

  function sendLead() {
    var btn = document.getElementById('btnSubmit');
    var email = document.getElementById('lEmail').value.trim();
    var phone = document.getElementById('lPhone').value.trim();

    if (!email && !phone) { toast(t('needContact'), 'error'); return; }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast(t('badEmail'), 'error'); return; }

    btn.disabled = true;
    btn.textContent = t('sending');

    fetch('/api/public/lead/' + encodeURIComponent(SLUG), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('lName').value.trim(),
        email: email, phone: phone,
        address: document.getElementById('lAddress').value.trim(),
        note: document.getElementById('lNote').value.trim(),
        company_website: document.getElementById('lHoney').value,
        input: input,
        lang: lang,
        sourceUrl: document.referrer || location.href
      })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Something went wrong.');
        if (res.d.message) branding.thanksMessage = res.d.message;
        stage = 'thanks';
        render();
        try { parent.postMessage({ type: 'quotecraft:lead', slug: SLUG }, '*'); } catch (_) {}
      })
      .catch(function (e) {
        toast(e.message || t('sendFailed'), 'error');
        btn.disabled = false;
        btn.textContent = t('sendQuote');
      });
  }
})();
