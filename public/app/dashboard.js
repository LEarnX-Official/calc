/**
 * QuoteCraft dashboard.
 *
 * Single-page, no framework. The whole app is one `state` object holding the
 * tenant record; every view renders from it and edits write straight back into
 * it. Nothing is persisted until "Save changes" — which is why `dirty` exists
 * and why we intercept page-leave while it's set.
 *
 * The live preview panel runs the SAME engine the widget and the server run,
 * so what an operator sees while dragging their hourly rate around is exactly
 * what a customer would be quoted.
 */
(function () {
  'use strict';

  var E = window.QuoteEngine;

  /* ── tiny helpers ──────────────────────────────────────────────────── */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var el = function (tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var uid = function (prefix, taken) {
    var n = 1, id;
    do { id = prefix + n++; } while (taken.some(function (x) { return x.id === id; }));
    return id;
  };

  var ICON = {
    trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    mail: '<path d="M4 6h16v12H4z"/><path d="M4 7l8 6 8-6"/>',
    inbox: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M5 5h14l2 8v6H3v-6z"/>',
    // ── the decorative icons a service can wear in the widget ──
    // These must stay in sync with ICONS in widget/widget.js; anything the
    // widget doesn't know falls back to sparkle there.
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    beaker: '<path d="M9 3h6M10 3v6L5 19a2 2 0 001.8 2h10.4A2 2 0 0019 19l-5-10V3"/>',
    box: '<path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8"/>',
    leaf: '<path d="M11 20A7 7 0 019 6c4-2 8-2 11-1 1 3 1 7-1 11a7 7 0 01-8 4zM4 20c2-4 5-7 9-9"/>',
    droplet: '<path d="M12 2.7l5 6.3a6.5 6.5 0 11-10 0z"/>',
    clock: '<path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/>'
  };
  var SERVICE_ICONS = [
    { id: 'sparkle', label: 'Sparkle' },
    { id: 'beaker', label: 'Beaker' },
    { id: 'box', label: 'Box' },
    { id: 'leaf', label: 'Leaf' },
    { id: 'droplet', label: 'Droplet' },
    { id: 'clock', label: 'Clock' }
  ];
  var svg = function (name, size) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round"' +
      (size ? ' width="' + size + '" height="' + size + '"' : '') + '>' + ICON[name] + '</svg>';
  };

  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.className = 'toast ' + (kind || ''); }, 3200);
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || 'Something went wrong.');
        return d;
      });
    });
  }

  function ago(iso) {
    var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  /* ── state ─────────────────────────────────────────────────────────── */
  var state = {
    tenant: null,
    stats: null,
    leads: [],
    verticals: [],
    view: 'overview',
    dirty: false,
    preview: null,     // input for the live preview panel
    leadFilter: 'all',
    leadSearch: '',
    openLead: null
  };

  var money = function (n) {
    return E.formatMoney(n, state.tenant ? state.tenant.config.currency : 'USD').replace(/\.00$/, '');
  };

  function markDirty() {
    state.dirty = true;
    $('#saveBtn').classList.remove('hidden');
  }

  /* ══════════════════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════════════════ */
  Promise.all([
    api('/api/config'),
    api('/api/stats').catch(function () { return { stats: {} }; }),
    api('/api/leads').catch(function () { return { leads: [] }; }),
    api('/api/verticals').catch(function () { return { verticals: [] }; })
  ]).then(function (r) {
    state.tenant = r[0].tenant;
    state.stats = r[1].stats;
    state.leads = r[2].leads;
    state.verticals = r[3].verticals;
    state.preview = E.defaultInput(state.tenant.config);
    boot();
  }).catch(function (e) {
    $('#body').innerHTML = '<div class="empty"><h4>Could not load your account</h4><p>' + esc(e.message) + '</p></div>';
  });

  function boot() {
    var t = state.tenant;
    $('#whoName').textContent = t.businessName;
    $('#whoEmail').textContent = t.email || '';
    $('#avatar').textContent = (t.businessName || 'Q').trim().charAt(0).toUpperCase();
    $('#previewBtn').href = '/w/' + t.slug;

    var count = state.leads.filter(function (l) { return l.status === 'new'; }).length;
    if (count) {
      $('#navLeadCount').textContent = count;
      $('#navLeadCount').classList.remove('hidden');
    }

    // nav
    Array.prototype.forEach.call(document.querySelectorAll('.side-link'), function (link) {
      link.onclick = function () { go(link.getAttribute('data-view')); };
    });

    $('#menuBtn').onclick = function () {
      $('#side').classList.add('open');
      $('#scrim').classList.add('open');
    };
    $('#scrim').onclick = closeSide;

    $('#saveBtn').onclick = save;
    $('#logout').onclick = function () {
      api('/api/auth/logout', { method: 'POST' }).then(function () { location.href = '/'; });
    };

    // Losing unsaved pricing changes is a genuinely bad afternoon.
    window.addEventListener('beforeunload', function (e) {
      if (!state.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });

    wireLeadModal();
    go(location.hash.replace('#', '') || 'overview');
  }

  function closeSide() {
    $('#side').classList.remove('open');
    $('#scrim').classList.remove('open');
  }

  var TITLES = {
    overview: ['Dashboard', 'How your calculator is doing'],
    leads: ['Leads', 'Everyone who asked for a quote'],
    pricing: ['Pricing', 'The numbers behind every quote'],
    services: ['Services & add-ons', 'What you offer and what it costs'],
    branding: ['Look & wording', 'How the calculator presents itself'],
    install: ['Install', 'Put the calculator on your website'],
    settings: ['Settings', 'Account, notifications and webhooks']
  };

  function go(view) {
    if (!TITLES[view]) view = 'overview';
    state.view = view;
    location.hash = view;
    closeSide();

    Array.prototype.forEach.call(document.querySelectorAll('.side-link'), function (l) {
      l.classList.toggle('active', l.getAttribute('data-view') === view);
    });
    $('#pageTitle').textContent = TITLES[view][0];
    $('#pageSub').textContent = TITLES[view][1];
    window.scrollTo(0, 0);
    render();
  }

  function render() {
    var box = $('#body');
    box.innerHTML = '';
    // Drop the previous view's preview painter — otherwise an edit on a page
    // without a panel would repaint a node that is no longer in the document.
    previewPanel._active = null;
    ({
      overview: viewOverview,
      leads: viewLeads,
      pricing: viewPricing,
      services: viewServices,
      branding: viewBranding,
      install: viewInstall,
      settings: viewSettings
    })[state.view](box);
  }

  /* ══════════════════════════════════════════════════════════════════════
     SAVE
     ══════════════════════════════════════════════════════════════════════ */
  function save() {
    var t = state.tenant;
    var errors = E.validateConfig(t.config);
    if (errors.length) {
      toast(errors[0], 'error');
      return;
    }
    var btn = $('#saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    api('/api/config', {
      method: 'PUT',
      body: {
        config: t.config,
        branding: t.branding,
        businessName: t.businessName,
        webhookUrl: t.webhookUrl,
        notifyEmail: t.notifyEmail
      }
    }).then(function () {
      state.dirty = false;
      btn.classList.add('hidden');
      toast('Saved — your calculator is live with the new prices.', 'success');
      $('#whoName').textContent = t.businessName;
    }).catch(function (e) {
      toast(e.message, 'error');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Save changes';
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     VIEW · OVERVIEW
     ══════════════════════════════════════════════════════════════════════ */
  function viewOverview(box) {
    var s = state.stats || {};
    var t = state.tenant;
    var v = el('div', 'view');

    var conv = s.quotesViewed ? Math.round((s.totalLeads / s.quotesViewed) * 100) : 0;

    v.appendChild(el('div', 'stats',
      '<div class="stat hero">' +
        '<div class="s-l">Open pipeline</div>' +
        '<div class="s-v">' + money(s.pipeline || 0) + '</div>' +
        '<div class="s-s">Quoted, not yet won or lost</div>' +
      '</div>' +
      '<div class="stat">' +
        '<div class="s-l">New leads</div>' +
        '<div class="s-v">' + (s.newLeads || 0) + '</div>' +
        '<div class="s-s">Waiting on you</div>' +
      '</div>' +
      '<div class="stat">' +
        '<div class="s-l">Last 30 days</div>' +
        '<div class="s-v">' + (s.leads30 || 0) + '</div>' +
        '<div class="s-s">' + (s.quotesViewed || 0) + ' calculator views · ' + conv + '% left details</div>' +
      '</div>' +
      '<div class="stat">' +
        '<div class="s-l">Won</div>' +
        '<div class="s-v">' + money(s.won || 0) + '</div>' +
        '<div class="s-s">Value of jobs marked won</div>' +
      '</div>'
    ));

    // ── not installed yet? that's the only thing that matters ──
    if (!s.quotesViewed) {
      var setup = el('div', 'card');
      setup.innerHTML =
        '<div class="card-head plain"><div>' +
          '<h3>One step left</h3>' +
          '<p class="sub">Your calculator is built and ready — it just isn\'t on your website yet.</p>' +
        '</div></div>' +
        '<p style="font-size:14px;color:var(--ink-600);line-height:1.7;margin-bottom:18px">' +
          'Paste one line of code into your site and this dashboard starts filling up with real leads. ' +
          'Takes about two minutes on any website builder.</p>';
      var b = el('button', 'btn btn-primary', 'Show me how to install it');
      b.onclick = function () { go('install'); };
      setup.appendChild(b);
      v.appendChild(setup);
    }

    // ── recent leads ──
    var recent = state.leads.slice(0, 6);
    var card = el('div', 'card card-flush');
    card.style.marginTop = '20px';
    var head = el('div', 'card-head');
    head.style.padding = '20px 24px';
    head.innerHTML = '<div><h3>Recent leads</h3><p class="sub">The last few people who asked for a price</p></div>';
    var all = el('button', 'btn btn-ghost btn-sm', 'View all');
    all.onclick = function () { go('leads'); };
    head.appendChild(all);
    card.appendChild(head);

    if (!recent.length) {
      card.appendChild(el('div', 'empty',
        '<span class="icon-tile">' + svg('inbox') + '</span>' +
        '<h4>No leads yet</h4>' +
        '<p>Once your calculator is live, everyone who gets a price and leaves their details will show up here.</p>'
      ));
    } else {
      var tbl = el('table', 'table');
      tbl.innerHTML = '<thead><tr><th>Name</th><th class="hide-md">Quote for</th><th>Value</th><th>Status</th><th class="hide-md">When</th></tr></thead>';
      var tb = el('tbody');
      recent.forEach(function (l) {
        var tr = el('tr');
        tr.innerHTML =
          '<td><div class="lead-name">' + esc(l.name || 'No name') + '</div>' +
            '<div class="lead-meta">' + esc(l.email || l.phone || '') + '</div></td>' +
          '<td class="hide-md">' + esc((l.quote && l.quote.serviceLabel) || '—') + '</td>' +
          '<td class="money">' + money(l.quoteTotal || 0) + '</td>' +
          '<td><span class="badge ' + badgeFor(l.status) + '">' + l.status + '</span></td>' +
          '<td class="hide-md tiny muted">' + ago(l.createdAt) + '</td>';
        tr.onclick = function () { openLead(l); };
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      card.appendChild(tbl);
    }
    v.appendChild(card);
    box.appendChild(v);
  }

  function badgeFor(st) {
    return { won: 'badge-sage', contacted: 'badge-apricot', lost: 'badge-quiet' }[st] || '';
  }

  /* ══════════════════════════════════════════════════════════════════════
     VIEW · LEADS
     ══════════════════════════════════════════════════════════════════════ */
  function viewLeads(box) {
    var v = el('div', 'view');

    var tools = el('div', 'lead-tools');
    var pills = el('div', 'pills');
    [['all', 'All'], ['new', 'New'], ['contacted', 'Contacted'], ['won', 'Won'], ['lost', 'Lost']]
      .forEach(function (p) {
        var n = p[0] === 'all' ? state.leads.length
          : state.leads.filter(function (l) { return l.status === p[0]; }).length;
        var b = el('button', 'pill' + (state.leadFilter === p[0] ? ' active' : ''), p[1] + ' · ' + n);
        b.onclick = function () { state.leadFilter = p[0]; render(); };
        pills.appendChild(b);
      });
    tools.appendChild(pills);

    var search = el('div', 'search');
    var si = el('input', 'input');
    si.type = 'search';
    si.placeholder = 'Search name, email, phone…';
    si.value = state.leadSearch;
    si.oninput = function () { state.leadSearch = si.value; paintRows(); };
    search.appendChild(si);
    tools.appendChild(search);

    var csv = el('a', 'btn btn-outline btn-sm', 'Export CSV');
    csv.href = '/api/leads.csv';
    tools.appendChild(csv);
    v.appendChild(tools);

    var wrap = el('div', 'table-wrap');
    var tbl = el('table', 'table');
    tbl.innerHTML = '<thead><tr><th>Name</th><th class="hide-md">Contact</th><th class="hide-md">Quote for</th><th>Value</th><th>Status</th><th class="hide-md">When</th></tr></thead>';
    var tb = el('tbody');
    tbl.appendChild(tb);
    wrap.appendChild(tbl);
    v.appendChild(wrap);
    box.appendChild(v);

    function paintRows() {
      var q = state.leadSearch.trim().toLowerCase();
      var rows = state.leads.filter(function (l) {
        if (state.leadFilter !== 'all' && l.status !== state.leadFilter) return false;
        if (!q) return true;
        return [l.name, l.email, l.phone, l.address].join(' ').toLowerCase().indexOf(q) !== -1;
      });

      tb.innerHTML = '';
      if (!rows.length) {
        wrap.querySelector('table').style.display = 'none';
        if (!wrap.querySelector('.empty')) {
          wrap.appendChild(el('div', 'empty',
            '<span class="icon-tile">' + svg('inbox') + '</span>' +
            '<h4>Nothing here</h4><p>No leads match that filter yet.</p>'));
        }
        return;
      }
      var e = wrap.querySelector('.empty');
      if (e) e.remove();
      wrap.querySelector('table').style.display = '';

      rows.forEach(function (l) {
        var tr = el('tr');
        tr.innerHTML =
          '<td><div class="lead-name">' + esc(l.name || 'No name') + '</div>' +
            '<div class="lead-meta">' + esc(l.address || '') + '</div></td>' +
          '<td class="hide-md"><div>' + esc(l.email || '—') + '</div>' +
            '<div class="lead-meta">' + esc(l.phone || '') + '</div></td>' +
          '<td class="hide-md">' + esc((l.quote && l.quote.serviceLabel) || '—') +
            '<div class="lead-meta">' + esc((l.quote && l.quote.frequencyLabel) || '') + '</div></td>' +
          '<td class="money">' + money(l.quoteTotal || 0) + '</td>' +
          '<td></td>' +
          '<td class="hide-md tiny muted">' + ago(l.createdAt) + '</td>';

        var sel = el('select', 'st-sel st-' + l.status);
        ['new', 'contacted', 'won', 'lost'].forEach(function (s) {
          var o = el('option', null, s.charAt(0).toUpperCase() + s.slice(1));
          o.value = s;
          if (s === l.status) o.selected = true;
          sel.appendChild(o);
        });
        sel.onclick = function (ev) { ev.stopPropagation(); };
        sel.onchange = function () { setStatus(l, sel.value, sel); };
        tr.children[4].appendChild(sel);

        tr.onclick = function () { openLead(l); };
        tb.appendChild(tr);
      });
    }
    paintRows();
  }

  function setStatus(lead, status, sel) {
    var prev = lead.status;
    lead.status = status;
    if (sel) sel.className = 'st-sel st-' + status;
    api('/api/leads/' + lead.id, { method: 'PATCH', body: { status: status } })
      .then(function () {
        var n = state.leads.filter(function (l) { return l.status === 'new'; }).length;
        var badge = $('#navLeadCount');
        badge.textContent = n;
        badge.classList.toggle('hidden', !n);
      })
      .catch(function (e) {
        lead.status = prev;
        if (sel) { sel.value = prev; sel.className = 'st-sel st-' + prev; }
        toast(e.message, 'error');
      });
  }

  /* ── lead modal ───────────────────────────────────────────────────── */
  function wireLeadModal() {
    var ov = $('#leadOverlay');
    $('#lmClose').onclick = closeLead;
    ov.onclick = function (e) { if (e.target === ov) closeLead(); };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeLead();
    });
    Array.prototype.forEach.call(ov.querySelectorAll('[data-st]'), function (b) {
      b.onclick = function () {
        if (!state.openLead) return;
        setStatus(state.openLead, b.getAttribute('data-st'));
        closeLead();
        render();
      };
    });
  }
  function closeLead() {
    $('#leadOverlay').classList.remove('open');
    state.openLead = null;
  }

  function openLead(l) {
    state.openLead = l;
    $('#lmName').textContent = l.name || 'No name given';
    $('#lmWhen').textContent = new Date(l.createdAt).toLocaleString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    var q = l.quote || {};
    var html =
      '<div class="lm-total">' +
        '<div><div class="t-v">' + money(l.quoteTotal || 0) + '</div>' +
        '<div class="t-s">' + esc(q.serviceLabel || 'Quote') +
          (q.frequencyLabel ? ' · ' + esc(q.frequencyLabel) : '') + '</div></div>' +
        (q.durationMinutes
          ? '<div style="text-align:right"><div class="t-s">Estimated time</div>' +
            '<div style="font-size:17px;font-weight:600">' + E.formatDuration(q.durationMinutes) + '</div></div>'
          : '') +
      '</div>' +
      '<div class="lm-grid">' +
        field('Email', l.email ? '<a href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a>' : '—') +
        field('Phone', l.phone ? '<a href="tel:' + esc(l.phone) + '">' + esc(l.phone) + '</a>' : '—') +
        field('Address', esc(l.address || '—')) +
        field('Came from', l.sourceUrl ? '<a href="' + esc(l.sourceUrl) + '" target="_blank" rel="noopener">' + esc(l.sourceUrl) + '</a>' : 'Direct') +
      '</div>' +
      (l.note ? '<div class="lm-list"><div class="lm-f"><div class="l">Their note</div>' +
        '<div class="v" style="line-height:1.65">' + esc(l.note) + '</div></div></div>' : '');

    // what they actually picked
    var lines = (q.lines || []).filter(function (x) { return x.kind !== 'base' ? x.qty : true; });
    if (lines.length || (q.addonLines || []).length) {
      html += '<div class="lm-list">' +
        '<div class="l" style="font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-400);font-weight:600;margin-bottom:8px">What they picked</div>';
      lines.forEach(function (x) {
        html += '<div class="lm-line"><span>' + esc(x.label) +
          (x.qty ? ' × ' + x.qty : '') + '</span><b>' + E.formatDuration(x.minutes) + '</b></div>';
      });
      (q.addonLines || []).forEach(function (a) {
        html += '<div class="lm-line"><span>+ ' + esc(a.label) +
          (a.qty > 1 ? ' × ' + a.qty : '') + '</span><b>' + money(a.price) + '</b></div>';
      });
      html += '</div>';
    }

    $('#lmBody').innerHTML = html;
    $('#lmHook').textContent = l.webhookState
      ? 'Webhook: ' + l.webhookState
      : '';
    $('#leadOverlay').classList.add('open');
  }

  function field(label, value) {
    return '<div class="lm-f"><div class="l">' + label + '</div><div class="v">' + value + '</div></div>';
  }

  /* ══════════════════════════════════════════════════════════════════════
     VIEW · PRICING
     ══════════════════════════════════════════════════════════════════════ */
  function viewPricing(box) {
    var c = state.tenant.config;
    var v = el('div', 'view two');
    var left = el('div');

    /* ── the rate card ── */
    var rate = el('div', 'card');
    rate.innerHTML = '<div class="card-head plain"><div><h3>Your rate</h3>' +
      '<p class="sub">Everything else is priced from these three numbers.</p></div></div>';

    var fr = el('div', 'field-row');
    fr.appendChild(numField('Hourly rate', c.hourlyRate,
      'What one hour of crew time is worth. Every quote is minutes ÷ 60 × this.',
      function (n) { c.hourlyRate = n; }, { prefix: '$', step: 1, min: 1 }));
    fr.appendChild(numField('Minimum charge', c.minimumPrice,
      'No job prices below this — it covers getting the van to the door.',
      function (n) { c.minimumPrice = n; }, { prefix: '$', step: 5, min: 0 }));
    rate.appendChild(fr);

    rate.appendChild(numField('Round prices to', c.roundTo,
      'Quote to the nearest dollar (1), or round to 5 or 10 for tidier numbers.',
      function (n) { c.roundTo = Math.max(0, n); }, { prefix: '$', step: 1, min: 0 }));

    rate.appendChild(numField('Across-the-board adjustment', c.priceFactor,
      'A single dial over everything. 1.10 puts every quote up 10% without touching a single tier — the fastest way to react to costs.',
      function (n) { c.priceFactor = n; }, { step: 0.05, min: 0.25, max: 4.9 }));
    left.appendChild(rate);

    /* ── team sizes ── */
    if (!Array.isArray(c.crewOptions) || !c.crewOptions.length) {
      // A config from before this feature only has a crewSize number. Promote
      // it so the editor has something real to show, instead of an empty list
      // that looks like the tenant deleted their own crew.
      c.crewOptions = [{
        id: 'crew' + Math.max(1, c.crewSize || 2), size: Math.max(1, c.crewSize || 2),
        label: 'Team of ' + Math.max(1, c.crewSize || 2), multiplier: 1
      }];
    }

    var crew = el('div', 'card');
    crew.innerHTML = '<div class="card-head plain"><div><h3>Team sizes</h3>' +
      '<p class="sub">Let customers pick how many people show up. Offer more than one and the ' +
      'calculator asks; offer one and it stays out of the way.</p></div></div>';

    crew.appendChild(rowList({
      cls: 'g-crew',
      head: ['Label', 'People', 'Price ×', 'Default', 'A 200 min job takes', ''],
      items: c.crewOptions,
      row: function (o, rowEl, repaint) {
        rowEl.appendChild(textInput(o.label, 'e.g. Team of 4', function (val) { o.label = val; }));
        rowEl.appendChild(bareNum(o.size, function (n) {
          o.size = Math.max(1, Math.round(n)); repaint();
        }, { min: 1, max: 20, step: 1 }));
        rowEl.appendChild(bareNum(o.multiplier != null ? o.multiplier : 1, function (n) {
          o.multiplier = n; repaint();
        }, { min: 0.1, max: 4.9, step: 0.05 }));
        rowEl.appendChild(switchCell(c.defaultCrew === o.id,
          'Start the calculator on this team size',
          function (on) {
            c.defaultCrew = on ? o.id : null;
            repaint();
            state.preview.crew = E.resolveCrew(c, c.defaultCrew).id;
          }));
        rowEl.appendChild(el('span', 'drv', '<b>' +
          E.formatDuration(Math.round(200 / Math.max(1, o.size))) + '</b> on site' +
          ((o.multiplier || 1) !== 1 ? ' · ×' + (o.multiplier || 1) : '')));
        rowEl.appendChild(delBtn(c.crewOptions, o, repaint, 'You need at least one team size.'));
      },
      addLabel: '+ Add a team size',
      onAdd: function () {
        var biggest = c.crewOptions.reduce(function (a, o) { return Math.max(a, o.size || 0); }, 0);
        var size = Math.min(20, biggest + 2);
        c.crewOptions.push({ id: uid('crew', c.crewOptions), size: size, label: 'Team of ' + size, multiplier: 1 });
      }
    }));

    crew.appendChild(el('div', 'hint-box',
      '<b>Why is the price the same?</b> A job is the same number of crew-minutes however many ' +
      'people you send — six people just finish it in a third of the time. So a bigger team shows ' +
      'the customer a shorter visit, not a bigger bill. If you genuinely charge more to send a rush ' +
      'crew, put that in the <b>Price ×</b> column — but make it a decision, not an accident.'));
    left.appendChild(crew);

    /* ── size tiers ── */
    var tiers = el('div', 'card');
    tiers.innerHTML = '<div class="card-head plain"><div><h3>' + esc(c.sizeLabel || 'Size') + '</h3>' +
      '<p class="sub">How long a job of each size takes your crew. This is the backbone of every quote.</p></div></div>';

    var tLabel = el('div', 'field');
    tLabel.innerHTML = '<label>What to call this question</label>';
    var tIn = el('input', 'input');
    tIn.value = c.sizeLabel || '';
    tIn.placeholder = 'Home size';
    tIn.oninput = function () { c.sizeLabel = tIn.value; markDirty(); };
    tLabel.appendChild(tIn);
    tiers.appendChild(tLabel);

    tiers.appendChild(rowList({
      cls: 'g-tier',
      head: ['Label', 'Minutes', 'Prices at', ''],
      items: c.sizeTiers,
      row: function (t, rowEl, repaint) {
        rowEl.appendChild(textInput(t.label, 'Label shown to customers', function (val) { t.label = val; }));

        if (t.custom) {
          var tag = el('span', 'badge badge-apricot', 'Ask me');
          tag.style.justifySelf = 'start';
          rowEl.appendChild(tag);
          rowEl.appendChild(el('span', 'drv', 'Shows a “contact us” message instead of a price'));
        } else {
          rowEl.appendChild(bareNum(t.minutes, function (n) { t.minutes = n; repaint(); }, { min: 1, step: 5 }));
          rowEl.appendChild(el('span', 'drv', 'about <b>' +
            money(Math.max(c.minimumPrice, (t.minutes * c.priceFactor / 60) * c.hourlyRate)) + '</b>'));
        }
        rowEl.appendChild(delBtn(c.sizeTiers, t, repaint, 'You need at least one size.'));
      },
      addLabel: '+ Add a size',
      onAdd: function () {
        var last = c.sizeTiers[c.sizeTiers.length - 1] || { minutes: 60 };
        c.sizeTiers.push({ id: uid('s', c.sizeTiers), label: 'New size', minutes: (last.minutes || 60) + 20 });
      }
    }));
    left.appendChild(tiers);

    /* ── modifiers ── */
    var mods = el('div', 'card');
    mods.innerHTML = '<div class="card-head plain"><div><h3>Extra rooms &amp; features</h3>' +
      '<p class="sub">Counters the customer steps up and down. Each one adds minutes on top of the size.</p></div></div>';

    mods.appendChild(rowList({
      cls: 'g-mod',
      head: ['Label', 'Min', 'Max', 'Start at', 'Minutes each', ''],
      items: c.modifiers || (c.modifiers = []),
      row: function (m, rowEl, repaint) {
        rowEl.appendChild(textInput(m.label, 'e.g. Bathrooms', function (val) { m.label = val; }));
        rowEl.appendChild(bareNum(m.min || 0, function (n) { m.min = n; }, { min: 0, step: 1 }));
        rowEl.appendChild(bareNum(m.max != null ? m.max : 6, function (n) { m.max = n; }, { min: 1, step: 1 }));
        rowEl.appendChild(bareNum(m.default || 0, function (n) { m.default = n; }, { min: 0, step: 1 }));

        if (m.curve) {
          // A tapering curve can't be expressed as one number, so show what it
          // does rather than pretending it's editable as a flat rate.
          var span = el('span', 'drv',
            'tapers <b>' + (m.curve[1] || 0) + '</b> → <b>' + (m.curve[m.curve.length - 1] - m.curve[m.curve.length - 2]) + '</b> min');
          span.title = 'The first one adds ' + (m.curve[1] || 0) + ' minutes, later ones add less. Switch to a flat rate to edit.';
          var flat = el('button', 'btn btn-ghost btn-sm', 'flat');
          flat.style.marginLeft = '8px';
          flat.onclick = function () {
            m.minutesEach = m.curve[1] || 15;
            delete m.curve;
            repaint();
            markDirty();
          };
          var holder = el('span');
          holder.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:4px';
          holder.appendChild(span);
          holder.appendChild(flat);
          rowEl.appendChild(holder);
        } else {
          rowEl.appendChild(bareNum(m.minutesEach || 0, function (n) { m.minutesEach = n; }, { min: 0, step: 5 }));
        }
        rowEl.appendChild(delBtn(c.modifiers, m, repaint));
      },
      addLabel: '+ Add a counter',
      onAdd: function () {
        c.modifiers.push({ id: uid('m', c.modifiers), label: 'New item', min: 0, max: 6, default: 0, minutesEach: 15 });
      }
    }));

    mods.appendChild(el('div', 'hint-box',
      '<b>Tapering:</b> the presets make each extra room add slightly less time than the one before, ' +
      'because your crew only sets up once. It reflects real jobs better than a flat rate — but a flat ' +
      'rate is easier to reason about, and you can switch any counter over.'));
    left.appendChild(mods);

    /* ── frequencies ── */
    var freq = el('div', 'card');
    freq.innerHTML = '<div class="card-head plain"><div><h3>Recurring discounts</h3>' +
      '<p class="sub">Showing these side by side is what turns a one-off clean into a customer worth thousands a year.</p></div></div>';

    freq.appendChild(rowList({
      cls: 'g-freq',
      head: ['Label', 'Discount %', 'A ' + money(200) + ' job becomes', ''],
      items: c.frequencies,
      row: function (f, rowEl, repaint) {
        rowEl.appendChild(textInput(f.label, 'e.g. Every 2 weeks', function (val) { f.label = val; }));
        rowEl.appendChild(bareNum(Math.round((f.discount || 0) * 100),
          function (n) { f.discount = Math.min(95, Math.max(0, n)) / 100; repaint(); },
          { min: 0, max: 95, step: 1 }));
        rowEl.appendChild(el('span', 'drv', '<b>' + money(200 * (1 - (f.discount || 0))) + '</b>'));
        rowEl.appendChild(delBtn(c.frequencies, f, repaint, 'You need at least one frequency.'));
      },
      addLabel: '+ Add a frequency',
      onAdd: function () {
        c.frequencies.push({ id: uid('f', c.frequencies), label: 'New frequency', discount: 0 });
      }
    }));
    left.appendChild(freq);

    v.appendChild(left);
    v.appendChild(previewPanel());
    box.appendChild(v);
  }

  /* ══════════════════════════════════════════════════════════════════════
     VIEW · SERVICES & ADD-ONS
     ══════════════════════════════════════════════════════════════════════ */
  function viewServices(box) {
    var c = state.tenant.config;
    var v = el('div', 'view two');
    var left = el('div');

    var svcs = el('div', 'card');
    svcs.innerHTML = '<div class="card-head plain"><div><h3>Service types</h3>' +
      '<p class="sub">The multiplier is how much longer this takes than your standard job. Keep one at 1.00.</p></div></div>';

    svcs.appendChild(rowList({
      cls: 'g-service',
      head: ['Icon', 'Name', 'Short description', 'Multiplier', 'Recurring?', ''],
      items: c.services,
      row: function (s, rowEl, repaint) {
        rowEl.appendChild(iconPicker(s.icon, function (id) { s.icon = id; }));
        rowEl.appendChild(textInput(s.label, 'e.g. Deep Clean', function (val) { s.label = val; }));
        rowEl.appendChild(textInput(s.blurb || '', 'One short line', function (val) { s.blurb = val; }));
        rowEl.appendChild(bareNum(s.multiplier, function (n) { s.multiplier = n; repaint(); },
          { min: 0.1, max: 5, step: 0.05 }));
        rowEl.appendChild(switchCell(s.allowRecurring !== false,
          'Can customers book this on a recurring schedule?',
          function (on) { s.allowRecurring = on; }));
        rowEl.appendChild(delBtn(c.services, s, repaint, 'You need at least one service.'));
      },
      addLabel: '+ Add a service',
      onAdd: function () {
        c.services.push({
          id: uid('sv', c.services), label: 'New service', blurb: '',
          multiplier: 1.2, icon: 'sparkle', allowRecurring: true
        });
      }
    }));

    svcs.appendChild(el('div', 'hint-box',
      '<b>Recurring off</b> means the calculator quietly switches to one-time when someone picks it — ' +
      'you don\'t want to sell a weekly move-out clean.'));
    left.appendChild(svcs);

    var adds = el('div', 'card');
    adds.innerHTML = '<div class="card-head plain"><div><h3>Add-ons</h3>' +
      '<p class="sub">Extras that stack on top. They are never discounted or swallowed by the minimum.</p></div></div>';

    adds.appendChild(rowList({
      cls: 'g-addon',
      head: ['Name', 'Price', 'Minutes', 'Per unit?', ''],
      items: c.addons || (c.addons = []),
      row: function (a, rowEl, repaint) {
        rowEl.appendChild(textInput(a.label, 'e.g. Inside oven', function (val) { a.label = val; }));
        rowEl.appendChild(bareNum(a.price, function (n) { a.price = n; repaint(); }, { min: 0, step: 5, prefix: true }));
        rowEl.appendChild(bareNum(a.minutes || 0, function (n) { a.minutes = n; }, { min: 0, step: 5 }));
        rowEl.appendChild(switchCell(a.perUnit === true,
          'On: the customer picks a quantity and the price multiplies. Off: one flat charge.',
          function (on) { a.perUnit = on; repaint(); }));
        rowEl.appendChild(delBtn(c.addons, a, repaint));
      },
      addLabel: '+ Add an add-on',
      onAdd: function () {
        c.addons.push({ id: uid('a', c.addons), label: 'New add-on', price: 40, minutes: 30, perUnit: false });
      }
    }));

    adds.appendChild(el('div', 'hint-box',
      'Turn <b>per unit</b> on for anything the customer counts — windows, loads of laundry, beds to change. ' +
      'They get a +/− stepper and the price and minutes multiply by the quantity. Off means one flat charge ' +
      'however many they have.<br/><br/>' +
      'The <b>minutes</b> only affect the "how long will it take" estimate customers see — the price is the ' +
      'amount you set. Keep them roughly honest so your crew\'s day doesn\'t get oversold.'));
    left.appendChild(adds);

    v.appendChild(left);
    v.appendChild(previewPanel());
    box.appendChild(v);
  }

  /* ══════════════════════════════════════════════════════════════════════
     LIVE PREVIEW PANEL
     ══════════════════════════════════════════════════════════════════════ */
  function previewPanel() {
    var c = state.tenant.config;
    var wrap = el('div');
    var p = el('div', 'preview');
    wrap.appendChild(p);

    function paint() {
      var q = E.quote(c, state.preview);
      var html;

      if (!q.ok) {
        html = '<div class="pv-l">Live preview</div><div class="pv-price">—</div>' +
          '<div class="pv-sub">Fix the config to see a price.</div>';
      } else if (q.isCustom) {
        html = '<div class="pv-l">Live preview</div><div class="pv-price" style="font-size:24px">Custom quote</div>' +
          '<div class="pv-sub">' + esc(q.message) + '</div>';
      } else {
        html =
          '<div class="pv-l">Live preview</div>' +
          '<div class="pv-price">' + money(q.total) + '</div>' +
          '<div class="pv-sub">' + esc(q.serviceLabel) + ' · ' + esc(q.frequencyLabel) +
            ' · ' + E.formatDuration(q.durationPerPerson, q.lang) + ' on site · ' + esc(q.crewLabel) + '</div>' +
          '<div class="pv-sec">' +
            '<div class="pv-line"><span>Crew time</span><span class="v">' + E.formatDuration(q.serviceMinutes, q.lang) + '</span></div>' +
            '<div class="pv-line"><span>At ' + money(q.hourlyRate) + '/hr</span><span class="v">' + money(q.grossPrice) + '</span></div>' +
            (q.discountAmount ? '<div class="pv-line"><span>Recurring −' + Math.round(q.discountPercent * 100) + '%</span>' +
              '<span class="v">−' + money(q.discountAmount) + '</span></div>' : '') +
            (q.minimumApplied ? '<div class="pv-line min"><span>Minimum applied</span><span class="v">' + money(q.minimumPrice) + '</span></div>' : '') +
            (q.addonsTotal ? '<div class="pv-line"><span>Add-ons</span><span class="v">' + money(q.addonsTotal) + '</span></div>' : '') +
          '</div>';
      }
      p.innerHTML = html;
      p.appendChild(controls());
    }

    function controls() {
      var box = el('div', 'pv-controls');

      box.appendChild(sel(c.sizeLabel || 'Size', c.sizeTiers, state.preview.size, function (id) {
        state.preview.size = id; paint();
      }));
      box.appendChild(sel('Service', c.services, state.preview.service, function (id) {
        state.preview.service = id; paint();
      }));
      box.appendChild(sel('Frequency', c.frequencies, state.preview.frequency, function (id) {
        state.preview.frequency = id; paint();
      }));

      var crews = E.crewOptions(c);
      if (crews.length > 1) {
        box.appendChild(sel('Team', crews, state.preview.crew, function (id) {
          state.preview.crew = id; paint();
        }));
      }

      // Only worth offering once there's Spanish to see — otherwise switching
      // shows the same English twice and reads like a bug.
      if (E.availableLangs(c).length > 1) {
        box.appendChild(sel('Language',
          [{ id: 'en', label: 'English' }, { id: 'es', label: 'Español' }],
          state.preview.lang || 'en',
          function (id) { state.preview.lang = id; paint(); }));
      }
      return box;
    }

    function sel(label, list, value, onChange) {
      var f = el('div', 'field');
      f.innerHTML = '<label>' + esc(label) + '</label>';
      var s = el('select', 'input');
      (list || []).forEach(function (x) {
        var o = el('option', null, esc(x.label || x.id));
        o.value = x.id;
        if (x.id === value) o.selected = true;
        s.appendChild(o);
      });
      s.onchange = function () { onChange(s.value); };
      f.appendChild(s);
      return f;
    }

    previewPanel._active = paint;
    paint();
    return wrap;
  }

  function refreshPreview() {
    if (previewPanel._active) previewPanel._active();
  }

  /* ══════════════════════════════════════════════════════════════════════
     VIEW · BRANDING
     ══════════════════════════════════════════════════════════════════════ */
  var PALETTES = [
    ['#5C4F87', 'Plum'], ['#1E5F74', 'Deep teal'], ['#2F6B4F', 'Forest'],
    ['#A94E36', 'Clay'], ['#2B4C7E', 'Navy'], ['#7A3E62', 'Mulberry'],
    ['#B07A2A', 'Ochre'], ['#3C3C3C', 'Charcoal']
  ];

  function viewBranding(box) {
    var b = state.tenant.branding;
    var v = el('div', 'view two');
    var left = el('div');

    /* colour */
    var col = el('div', 'card');
    col.innerHTML = '<div class="card-head plain"><div><h3>Accent colour</h3>' +
      '<p class="sub">Used for buttons and highlights so the calculator reads as part of your site.</p></div></div>';

    var row = el('div', 'color-row');
    var picker = el('input');
    picker.type = 'color';
    picker.value = b.accent || '#5C4F87';
    var hex = el('input', 'input');
    hex.value = b.accent || '#5C4F87';
    hex.style.maxWidth = '140px';
    hex.style.fontFamily = 'ui-monospace, monospace';

    function setAccent(val) {
      b.accent = val;
      picker.value = val;
      hex.value = val;
      Array.prototype.forEach.call(col.querySelectorAll('.swatch'), function (s) {
        s.classList.toggle('active', s.getAttribute('data-c').toLowerCase() === val.toLowerCase());
      });
      markDirty();
    }
    picker.oninput = function () { setAccent(picker.value); };
    hex.onchange = function () {
      if (/^#[0-9a-f]{6}$/i.test(hex.value)) setAccent(hex.value);
      else hex.value = b.accent;
    };
    row.appendChild(picker);
    row.appendChild(hex);
    col.appendChild(row);

    var sw = el('div', 'swatches');
    PALETTES.forEach(function (p) {
      var s = el('div', 'swatch' + (p[0].toLowerCase() === (b.accent || '').toLowerCase() ? ' active' : ''));
      s.style.background = p[0];
      s.title = p[1];
      s.setAttribute('data-c', p[0]);
      s.onclick = function () { setAccent(p[0]); };
      sw.appendChild(s);
    });
    col.appendChild(sw);
    left.appendChild(col);

    /* wording */
    var words = el('div', 'card');
    words.innerHTML = '<div class="card-head plain"><div><h3>Wording</h3>' +
      '<p class="sub">Say it the way you\'d say it on the phone.</p></div></div>';

    words.appendChild(textField('Headline', b.headline, 'Get your instant price',
      function (val) { b.headline = val; }));
    words.appendChild(areaField('Sub-heading', b.subhead,
      'One line under the headline explaining what to do.',
      function (val) { b.subhead = val; }));
    words.appendChild(textField('Button that asks for their details', b.ctaLabel, 'Email me this quote',
      function (val) { b.ctaLabel = val; }, 'The single highest-leverage sentence in the whole thing. “Email me this quote” beats “Submit”.'));
    words.appendChild(areaField('Thank-you message', b.thanksMessage,
      'What they see after they send their details.',
      function (val) { b.thanksMessage = val; }));
    left.appendChild(words);

    /* toggles */
    var opts = el('div', 'card');
    opts.innerHTML = '<div class="card-head plain"><div><h3>What to show</h3>' +
      '<p class="sub">Fewer numbers is sometimes a stronger quote.</p></div></div>';

    [
      ['showRecurring', 'Compare all frequencies', 'Shows weekly / fortnightly / one-time side by side. This is what sells recurring plans.'],
      ['showRange', 'Show a price range', 'Displays a from–to band instead of one hard figure. Useful if your jobs vary a lot on site.'],
      ['showDuration', 'Show estimated time', 'Tells customers roughly how long the crew will be there.']
    ].forEach(function (t) {
      var r = el('div', 'toggle-row');
      r.innerHTML = '<div><div class="t-name">' + t[1] + '</div><div class="t-help">' + t[2] + '</div></div>';
      var sw2 = el('button', 'switch' + (b[t[0]] ? ' on' : ''));
      sw2.type = 'button';
      sw2.onclick = function () {
        b[t[0]] = !b[t[0]];
        sw2.classList.toggle('on', !!b[t[0]]);
        markDirty();
      };
      r.appendChild(sw2);
      opts.appendChild(r);
    });
    left.appendChild(opts);

    left.appendChild(spanishCard());

    v.appendChild(left);

    /* side: how it'll look */
    var side = el('div');
    var card = el('div', 'card');
    card.innerHTML = '<div class="card-head plain"><div><h3>Preview</h3>' +
      '<p class="sub">Open the live widget to see your changes after saving.</p></div></div>';
    var open = el('a', 'btn btn-outline btn-block', 'Open my calculator');
    open.href = '/w/' + state.tenant.slug;
    open.target = '_blank';
    open.rel = 'noopener';
    card.appendChild(open);
    card.appendChild(el('div', 'hint-box',
      'Changes go live the moment you hit <b>Save changes</b> — there\'s nothing to re-publish and no code to re-paste.'));
    side.appendChild(card);
    v.appendChild(side);

    box.appendChild(v);
  }

  /* ══════════════════════════════════════════════════════════════════════
     SPANISH
     A translation table rather than a second copy of the whole editor: the
     English is right there, read-only, so you're translating a line rather
     than remembering what you wrote. Anything left blank falls back to the
     English, which means a half-finished translation is still shippable.
     ══════════════════════════════════════════════════════════════════════ */
  function spanishCard() {
    var c = state.tenant.config;
    var b = state.tenant.branding;

    var card = el('div', 'card');
    card.innerHTML = '<div class="card-head plain"><div><h3>Spanish</h3>' +
      '<p class="sub">Fill in what you want translated. Anything you leave blank stays in ' +
      'English, so you can do this a few lines at a time.</p></div></div>';

    /* the toggle */
    var togRow = el('div', 'toggle-row');
    togRow.innerHTML = '<div><div class="t-name">Offer customers a language switch</div>' +
      '<div class="t-help">Appears in the widget only once you\'ve written some Spanish — ' +
      'nobody sees a button that does nothing.</div></div>';
    var tog = el('button', 'switch' + (b.showLanguageToggle !== false ? ' on' : ''));
    tog.type = 'button';
    tog.onclick = function () {
      b.showLanguageToggle = b.showLanguageToggle === false;
      tog.classList.toggle('on', b.showLanguageToggle !== false);
      markDirty();
    };
    togRow.appendChild(tog);
    card.appendChild(togRow);

    /* your own wording */
    card.appendChild(el('div', 'sec-label', 'Your wording'));
    card.appendChild(textField('Headline', b.headlineEs, 'Obtén tu precio al instante',
      function (val) { b.headlineEs = val; }));
    card.appendChild(areaField('Sub-heading', b.subheadEs,
      'Una línea explicando qué hacer.', function (val) { b.subheadEs = val; }));
    card.appendChild(textField('Button', b.ctaLabelEs, 'Envíame este presupuesto',
      function (val) { b.ctaLabelEs = val; }));
    card.appendChild(areaField('Thank-you message', b.thanksMessageEs,
      'Lo que ven después de enviar sus datos.', function (val) { b.thanksMessageEs = val; }));

    /* everything the calculator asks about */
    var counter = el('p', 'hint');

    function pairs() {
      var out = [{ obj: c, field: 'sizeLabel', group: 'The size question' }];
      [['sizeTiers', 'Sizes'], ['modifiers', 'Counters'], ['services', 'Services'],
       ['frequencies', 'Frequencies'], ['addons', 'Add-ons'], ['crewOptions', 'Team sizes']
      ].forEach(function (g) {
        (c[g[0]] || []).forEach(function (item) {
          out.push({ obj: item, field: 'label', group: g[1] });
          // Only offer the secondary lines that actually exist — an empty
          // Spanish box for a blurb the tenant never wrote is just noise.
          if (item.blurb) out.push({ obj: item, field: 'blurb', group: g[1] });
          if (item.help) out.push({ obj: item, field: 'help', group: g[1] });
          if (item.customMessage) out.push({ obj: item, field: 'customMessage', group: g[1] });
        });
      });
      return out.filter(function (p) { return p.obj[p.field]; });
    }

    function tally(list) {
      var done = list.filter(function (p) {
        var v = p.obj[p.field + 'Es'];
        return v != null && String(v).trim() !== '';
      }).length;
      counter.textContent = done + ' of ' + list.length + ' translated' +
        (done === 0 ? ' — the switch stays hidden until at least one is filled in.' : '.');
    }

    var list = pairs();
    var table = el('div', 'rows');
    var lastGroup = null;
    list.forEach(function (p) {
      if (p.group !== lastGroup) {
        lastGroup = p.group;
        var h = el('div', 'rows-head g-lang');
        h.appendChild(el('span', null, p.group));
        h.appendChild(el('span', null, 'Español'));
        table.appendChild(h);
      }
      var r = el('div', 'erow g-lang');
      var en = el('span', 'lang-en', esc(p.obj[p.field]));
      en.title = p.obj[p.field];
      r.appendChild(en);
      r.appendChild(textInput(p.obj[p.field + 'Es'], 'Traducción…', function (val) {
        p.obj[p.field + 'Es'] = val;
        tally(list);
      }));
      table.appendChild(r);
    });

    card.appendChild(el('div', 'sec-label', 'What the calculator asks'));
    card.appendChild(table);
    tally(list);
    card.appendChild(counter);
    return card;
  }

  /* ══════════════════════════════════════════════════════════════════════
     VIEW · INSTALL
     ══════════════════════════════════════════════════════════════════════ */
  function viewInstall(box) {
    var t = state.tenant;
    var origin = location.origin;
    var snippet = '<script src="' + origin + '/embed.js" data-quotecraft="' + t.slug + '"><\/script>';

    var v = el('div', 'view');

    var card = el('div', 'card');
    card.innerHTML = '<div class="card-head plain"><div><h3>Your embed code</h3>' +
      '<p class="sub">Paste this into your website wherever you want the calculator to appear.</p></div></div>';

    var boxEl = el('div', 'embed-box');
    boxEl.innerHTML = '<div class="code">' +
      '<span class="tag">&lt;script</span> <span class="attr">src</span>=<span class="str">"' +
      esc(origin) + '/embed.js"</span> <span class="attr">data-quotecraft</span>=<span class="str">"' +
      esc(t.slug) + '"</span><span class="tag">&gt;&lt;/script&gt;</span></div>';

    var copy = el('button', 'btn btn-primary btn-sm copy-btn', 'Copy');
    copy.onclick = function () {
      navigator.clipboard.writeText(snippet).then(function () {
        copy.innerHTML = svg('check', 14) + ' Copied';
        toast('Embed code copied.', 'success');
        setTimeout(function () { copy.textContent = 'Copy'; }, 2000);
      }).catch(function () { toast('Press Ctrl+C to copy.', 'error'); });
    };
    boxEl.appendChild(copy);
    card.appendChild(boxEl);

    card.appendChild(el('div', 'hint-box',
      'It loads in its own frame and resizes itself to fit, so your theme can\'t break it and it can\'t ' +
      'break your theme. Put it inside a full-width section for the best result.'));
    v.appendChild(card);

    /* direct link */
    var link = el('div', 'card');
    link.innerHTML = '<div class="card-head plain"><div><h3>Or share a direct link</h3>' +
      '<p class="sub">No website? Send this straight to customers, or use it in your Google Business profile and ads.</p></div></div>';
    var lb = el('div', 'embed-box');
    lb.innerHTML = '<div class="code"><span class="str">' + esc(origin + '/w/' + t.slug) + '</span></div>';
    var lc = el('button', 'btn btn-outline btn-sm copy-btn', 'Copy');
    lc.onclick = function () {
      navigator.clipboard.writeText(origin + '/w/' + t.slug).then(function () {
        toast('Link copied.', 'success');
      });
    };
    lb.appendChild(lc);
    link.appendChild(lb);
    v.appendChild(link);

    /* platform notes */
    var plat = el('div', 'card');
    plat.innerHTML = '<div class="card-head plain"><div><h3>Where to paste it</h3>' +
      '<p class="sub">Every builder calls it something slightly different.</p></div></div>';
    var g = el('div', 'plat');
    [
      ['WordPress', 'Edit the page, add a <b>Custom HTML</b> block, paste the code in. Works in Elementor and Divi too — look for an HTML widget.'],
      ['Wix', 'Add → Embed Code → <b>Embed HTML</b>. Paste it, then drag the box wide and tall; the calculator sizes itself inside.'],
      ['Squarespace', 'Add a block → <b>Code</b>. Paste it and turn off "Display Source".'],
      ['GoHighLevel', 'In the funnel/site builder, drop a <b>Custom JS/HTML</b> element into the section and paste.'],
      ['Webflow', 'Drag in an <b>Embed</b> element and paste. Publish for it to run.'],
      ['Anything else', 'If you can add HTML to a page, you can add this. It\'s one standard script tag with no dependencies.']
    ].forEach(function (p) {
      g.appendChild(el('div', 'plat-card', '<h4>' + p[0] + '</h4><p>' + p[1] + '</p>'));
    });
    plat.appendChild(g);
    v.appendChild(plat);

    /* options */
    var opt = el('div', 'card');
    opt.innerHTML = '<div class="card-head plain"><div><h3>Optional attributes</h3>' +
      '<p class="sub">For when you want more control over placement.</p></div></div>' +
      '<div class="code" style="line-height:1.9">' +
      '<span class="attr">data-target</span>=<span class="str">"#quote-here"</span>  ' +
      '<span style="color:var(--ink-400)">— mount into that element instead of where the tag sits</span><br/>' +
      '<span class="attr">data-max-width</span>=<span class="str">"1100px"</span>  ' +
      '<span style="color:var(--ink-400)">— widen or narrow the calculator</span></div>' +
      '<div class="hint-box" style="margin-top:14px">The page also fires a <b>quotecraft:lead</b> browser event ' +
      'when someone submits, and pings Google Analytics and the Meta pixel automatically if you have them installed — ' +
      'so your ad platforms can optimise for real leads.</div>';
    v.appendChild(opt);

    box.appendChild(v);
  }

  /* ══════════════════════════════════════════════════════════════════════
     VIEW · SETTINGS
     ══════════════════════════════════════════════════════════════════════ */
  function viewSettings(box) {
    var t = state.tenant;
    var v = el('div', 'view');

    /* business */
    var biz = el('div', 'card');
    biz.innerHTML = '<div class="card-head plain"><div><h3>Business</h3>' +
      '<p class="sub">What customers see on the calculator.</p></div></div>';
    biz.appendChild(textField('Business name', t.businessName, 'Your business',
      function (val) { t.businessName = val; }));

    var slug = el('div', 'field');
    slug.innerHTML = '<label>Your calculator address</label>' +
      '<div class="code" style="font-size:12.5px">' + esc(location.origin + '/w/' + t.slug) + '</div>' +
      '<p class="hint">Fixed once your account is created, so links you\'ve already shared keep working.</p>';
    biz.appendChild(slug);
    v.appendChild(biz);

    /* notifications */
    var notify = el('div', 'card');
    notify.innerHTML = '<div class="card-head plain"><div><h3>Lead notifications</h3>' +
      '<p class="sub">Where new leads should go the moment they land.</p></div></div>';
    notify.appendChild(textField('Notification email', t.notifyEmail || '', 'you@yourbusiness.com',
      function (val) { t.notifyEmail = val.trim() || null; },
      'We\'ll send each new lead here with the full quote attached.'));

    var hookField = textField('Webhook URL', t.webhookUrl || '', 'https://hooks.zapier.com/…',
      function (val) { t.webhookUrl = val.trim() || null; },
      'Every lead is POSTed here as JSON within seconds. Works with Zapier, Make, HighLevel or your own endpoint. Must be https.');
    notify.appendChild(hookField);

    var testRow = el('div', 'row');
    testRow.style.marginTop = '-6px';
    var test = el('button', 'btn btn-outline btn-sm', 'Send a test lead');
    test.onclick = function () {
      var url = hookField.querySelector('input').value.trim();
      if (!url) return toast('Enter a webhook URL first.', 'error');
      test.disabled = true;
      test.textContent = 'Sending…';
      api('/api/webhook/test', { method: 'POST', body: { url: url } })
        .then(function (d) { toast(d.message || 'Test lead delivered.', 'success'); })
        .catch(function (e) { toast(e.message, 'error'); })
        .then(function () { test.disabled = false; test.textContent = 'Send a test lead'; });
    };
    testRow.appendChild(test);
    notify.appendChild(testRow);

    notify.appendChild(el('div', 'hint-box',
      'The payload includes the contact details, the full quote breakdown and the page they came from — ' +
      'enough to create a deal in your CRM and start a follow-up sequence without anyone touching it.'));
    v.appendChild(notify);

    /* plan */
    var plan = el('div', 'card');
    plan.innerHTML = '<div class="card-head plain"><div><h3>Plan</h3>' +
      '<p class="sub">You\'re on the <b>' + esc(t.plan) + '</b> plan.</p></div></div>' +
      '<p style="font-size:14px;color:var(--ink-600);line-height:1.7">' +
      'Signed up ' + new Date(t.createdAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) +
      ' · ' + esc(t.email || '') + '</p>';
    v.appendChild(plan);

    /* reset */
    var danger = el('div', 'card danger');
    danger.innerHTML = '<div class="card-head plain"><div><h3>Start over</h3>' +
      '<p class="sub">Throw away your pricing and reload the preset for a trade. Your leads are untouched.</p></div></div>';

    var pick = el('div', 'field');
    pick.innerHTML = '<label>Reload preset for</label>';
    var ps = el('select', 'input');
    (state.verticals.length ? state.verticals : [{ id: t.vertical, name: t.vertical }]).forEach(function (x) {
      var o = el('option', null, esc(x.name));
      o.value = x.id;
      if (x.id === t.vertical) o.selected = true;
      ps.appendChild(o);
    });
    pick.appendChild(ps);
    danger.appendChild(pick);

    var reset = el('button', 'btn btn-danger', 'Reset my pricing');
    reset.onclick = function () {
      if (!confirm('This replaces all your pricing with the preset. Your leads and settings stay. Continue?')) return;
      reset.disabled = true;
      api('/api/config/reset', { method: 'POST', body: { vertical: ps.value } })
        .then(function (d) {
          t.config = d.config;
          t.vertical = d.vertical;
          state.preview = E.defaultInput(t.config);
          state.dirty = false;
          $('#saveBtn').classList.add('hidden');
          toast('Pricing reset to the preset.', 'success');
          go('pricing');
        })
        .catch(function (e) { toast(e.message, 'error'); reset.disabled = false; });
    };
    danger.appendChild(reset);
    v.appendChild(danger);

    box.appendChild(v);
  }

  /* ══════════════════════════════════════════════════════════════════════
     SHARED FIELD BUILDERS
     ══════════════════════════════════════════════════════════════════════ */
  function textField(label, value, placeholder, onChange, hint) {
    var f = el('div', 'field');
    f.innerHTML = '<label>' + esc(label) + '</label>';
    var i = el('input', 'input');
    i.value = value || '';
    i.placeholder = placeholder || '';
    i.oninput = function () { onChange(i.value); markDirty(); };
    f.appendChild(i);
    if (hint) f.appendChild(el('p', 'hint', hint));
    return f;
  }

  function areaField(label, value, placeholder, onChange) {
    var f = el('div', 'field');
    f.innerHTML = '<label>' + esc(label) + '</label>';
    var i = el('textarea', 'input');
    i.rows = 2;
    i.value = value || '';
    i.placeholder = placeholder || '';
    i.oninput = function () { onChange(i.value); markDirty(); };
    f.appendChild(i);
    return f;
  }

  function numField(label, value, hint, onChange, opt) {
    opt = opt || {};
    var f = el('div', 'field');
    f.innerHTML = '<label>' + esc(label) + '</label>';

    var wrap = el('div', 'input-affix');
    if (opt.prefix) wrap.appendChild(el('span', 'affix', opt.prefix));
    var i = el('input', 'input');
    i.type = 'number';
    i.value = value;
    i.step = opt.step || 1;
    if (opt.min != null) i.min = opt.min;
    if (opt.max != null) i.max = opt.max;
    if (opt.prefix) i.style.paddingLeft = '28px';
    i.oninput = function () {
      var n = parseFloat(i.value);
      if (isNaN(n)) return;
      onChange(n);
      markDirty();
      refreshPreview();
    };
    wrap.appendChild(i);
    f.appendChild(wrap);
    if (hint) f.appendChild(el('p', 'hint', hint));
    return f;
  }

  function textInput(value, placeholder, onChange) {
    var i = el('input', 'input');
    i.value = value || '';
    i.placeholder = placeholder || '';
    i.oninput = function () { onChange(i.value); markDirty(); refreshPreview(); };
    return i;
  }

  function bareNum(value, onChange, opt) {
    opt = opt || {};
    var i = el('input', 'input num-in');
    i.type = 'number';
    i.value = value;
    i.step = opt.step || 1;
    if (opt.min != null) i.min = opt.min;
    if (opt.max != null) i.max = opt.max;
    i.oninput = function () {
      var n = parseFloat(i.value);
      if (isNaN(n)) return;
      onChange(n);
      markDirty();
      refreshPreview();
    };
    return i;
  }

  /**
   * The little glyph a service wears in the widget. Cycles through the icon
   * set on click rather than opening a dropdown — there are only six, and a
   * <select> of icon names would make you guess what each one looks like.
   */
  function iconPicker(value, onChange) {
    var idx = 0;
    SERVICE_ICONS.forEach(function (x, i) { if (x.id === value) idx = i; });

    var b = el('button', 'icon-pick');
    b.type = 'button';
    function paint() {
      b.innerHTML = svg(SERVICE_ICONS[idx].id, 17);
      b.title = SERVICE_ICONS[idx].label + ' — click to change';
    }
    paint();
    b.onclick = function () {
      idx = (idx + 1) % SERVICE_ICONS.length;
      paint();
      onChange(SERVICE_ICONS[idx].id);
      markDirty();
      refreshPreview();
    };

    var w = el('span');
    w.style.cssText = 'display:flex;justify-content:center';
    w.appendChild(b);
    return w;
  }

  /** A centred on/off switch for a boolean field on a row. */
  function switchCell(on, title, onChange) {
    var t = el('button', 'switch' + (on ? ' on' : ''));
    t.type = 'button';
    t.title = title;
    t.onclick = function () {
      on = !on;
      t.classList.toggle('on', on);
      onChange(on);
      markDirty();
      refreshPreview();
    };
    var w = el('span');
    w.style.cssText = 'display:flex;justify-content:center';
    w.appendChild(t);
    return w;
  }

  function delBtn(list, item, repaint, guard) {
    var b = el('button', 'del-btn', svg('trash'));
    b.type = 'button';
    b.title = 'Remove';
    b.onclick = function () {
      if (list.length <= 1 && guard) return toast(guard, 'error');
      list.splice(list.indexOf(item), 1);
      markDirty();
      repaint();
      refreshPreview();
    };
    return b;
  }

  /**
   * An editable list of rows with a header, an add button, and a `repaint`
   * that rebuilds only the rows — so deleting row 3 doesn't blow away the
   * focus and scroll position of the whole page.
   */
  function rowList(spec) {
    var host = el('div');
    var rows = el('div', 'rows');
    var head = el('div', 'rows-head ' + spec.cls);
    spec.head.forEach(function (h) { head.appendChild(el('span', null, h)); });

    function repaint() {
      rows.innerHTML = '';
      rows.appendChild(head);
      if (!spec.items.length) {
        rows.appendChild(el('div', 'erow', '<span class="muted tiny">Nothing here yet — add one below.</span>'));
      }
      spec.items.forEach(function (item) {
        var r = el('div', 'erow ' + spec.cls);
        spec.row(item, r, repaint);
        rows.appendChild(r);
      });
    }
    repaint();
    host.appendChild(rows);

    var add = el('button', 'add-btn', spec.addLabel);
    add.type = 'button';
    add.onclick = function () {
      spec.onAdd();
      markDirty();
      repaint();
      refreshPreview();
    };
    host.appendChild(add);
    return host;
  }
})();
