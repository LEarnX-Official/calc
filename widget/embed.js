/**
 * QuoteCraft embed loader.
 *
 *   <script src="https://yourdomain.com/embed.js" data-quotecraft="your-slug"></script>
 *
 * Creates a sandboxed iframe where the tag sits and keeps it exactly as tall as
 * its content. An iframe (rather than injecting markup) means the host page's
 * CSS can never break the widget, and our CSS can never break their page — the
 * single most common support complaint with embeddable tools.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].src && all[i].src.indexOf('embed.js') !== -1) { script = all[i]; break; }
    }
  }
  if (!script) return;

  var slug = script.getAttribute('data-quotecraft');
  if (!slug) {
    console.warn('[QuoteCraft] Missing data-quotecraft="your-slug" on the embed script tag.');
    return;
  }
  if (document.querySelector('[data-quotecraft-frame="' + slug + '"]')) return; // don't double-mount

  var origin = new URL(script.src, location.href).origin;
  var targetSel = script.getAttribute('data-target');
  var maxWidth = script.getAttribute('data-max-width') || '980px';

  var frame = document.createElement('iframe');
  frame.src = origin + '/w/' + encodeURIComponent(slug);
  frame.setAttribute('data-quotecraft-frame', slug);
  frame.setAttribute('title', 'Instant pricing calculator');
  frame.setAttribute('loading', 'lazy');
  frame.setAttribute('scrolling', 'no');
  frame.setAttribute('allow', 'clipboard-write');
  frame.style.cssText = [
    'width:100%', 'max-width:' + maxWidth, 'margin:0 auto', 'display:block',
    'border:0', 'height:760px', 'overflow:hidden',
    'transition:height .18s cubic-bezier(.22,.61,.36,1)'
  ].join(';');

  function mount() {
    var target = targetSel ? document.querySelector(targetSel) : null;
    if (target) target.appendChild(frame);
    else if (script.parentNode) script.parentNode.insertBefore(frame, script.nextSibling);
    else document.body.appendChild(frame);
  }

  if (document.readyState === 'loading' && targetSel) {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.addEventListener('message', function (ev) {
    if (ev.origin !== origin) return;                      // only trust our own frame
    var d = ev.data;
    if (!d || d.slug !== slug) return;

    if (d.type === 'quotecraft:height' && d.height > 0) {
      frame.style.height = Math.max(320, Math.min(6000, d.height)) + 'px';
    }

    // Let the host page hook conversions into its own analytics.
    if (d.type === 'quotecraft:lead') {
      try {
        window.dispatchEvent(new CustomEvent('quotecraft:lead', { detail: { slug: slug } }));
        if (typeof window.gtag === 'function') {
          window.gtag('event', 'generate_lead', { event_category: 'quotecraft', event_label: slug });
        }
        if (typeof window.fbq === 'function') window.fbq('track', 'Lead');
      } catch (_) {}
    }
  });
})();
