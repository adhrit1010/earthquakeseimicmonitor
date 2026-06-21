/* ---------------------------------------------------------------------
   depth.js (v3 — fixed position:fixed breaking)

   ROOT CAUSE OF THE BUG:
   depth.js was injecting .depth-bg with `insertBefore(wrap, body.firstChild)`,
   making it the FIRST element in <body>. The SVGs inside .depth-bg had
   `filter: drop-shadow(...)` applied via depth.css. A CSS `filter` on
   any element creates a new stacking context — and critically, when that
   filtered element is an ancestor or early sibling of position:fixed
   elements, it can break their fixed positioning in Chromium, causing
   them to position relative to the document instead of the viewport.

   FIX (two parts):
   1. Append .depth-bg at the END of <body> (after the FAB and panel)
      instead of prepending it, so filtered elements never precede fixed
      ones in the paint order.
   2. Remove `filter: drop-shadow` from the SVGs entirely — the subtle
      glow isn't worth the stacking-context side-effects. Opacity alone
      is used for the ambient fade effect instead.

   Everything else (sphere, rings, scroll-reveal) is unchanged.
--------------------------------------------------------------------- */

(function () {
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SKIP_AMBIENT_MOTION = REDUCED_MOTION
    || window.matchMedia('(pointer: coarse)').matches
    || window.innerWidth < 760;

  /* ===================== AMBIENT GOLD WIREFRAME ===================== */

  function buildDepthBackground() {
    if (SKIP_AMBIENT_MOTION) return;
    if (document.querySelector('.depth-bg')) return;
    const wrap = document.createElement('div');
    wrap.className = 'depth-bg';
    wrap.setAttribute('aria-hidden', 'true');

    const sphereSize = 520;
    const sphereSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sphereSvg.setAttribute('viewBox', `0 0 ${sphereSize} ${sphereSize}`);
    sphereSvg.setAttribute('width', sphereSize);
    sphereSvg.setAttribute('height', sphereSize);
    sphereSvg.classList.add('depth-sphere');
    sphereSvg.style.right = '-120px';
    sphereSvg.style.top = '8%';
    // NO filter here — filter on SVG breaks position:fixed on siblings

    const cx = sphereSize / 2;
    const cy = sphereSize / 2;
    const r = sphereSize / 2 - 12;

    let sphereInner = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffcf40" stroke-width="1" opacity="0.55"/>`;

    const latCount = 5;
    for (let i = 1; i < latCount; i++) {
      const t = i / latCount;
      const yOff = (t - 0.5) * 2 * r;
      const ellipseRx = r;
      const ellipseRy = Math.max(2, r * 0.18) * (1 - Math.abs(t - 0.5) * 0.6);
      sphereInner += `<ellipse class="lat-line" cx="${cx}" cy="${(cy + yOff).toFixed(2)}" rx="${ellipseRx.toFixed(2)}" ry="${ellipseRy.toFixed(2)}" fill="none" stroke="#ffcf40" stroke-width="0.75" opacity="0.4"/>`;
    }

    const lonCount = 6;
    for (let i = 0; i < lonCount; i++) {
      sphereInner += `<ellipse class="lon-line" cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" fill="none" stroke="#ffcf40" stroke-width="0.75" opacity="0.4"/>`;
    }

    sphereSvg.innerHTML = sphereInner;

    sphereSvg.querySelectorAll('.lon-line').forEach((el, i) => {
      el.style.transformOrigin = `${cx}px ${cy}px`;
      el.style.animation = `depth-lon-spin 22s linear infinite`;
      el.style.animationDelay = `${(i / lonCount) * -22}s`;
    });

    const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ringSvg.setAttribute('viewBox', '0 0 700 700');
    ringSvg.setAttribute('width', 700);
    ringSvg.setAttribute('height', 700);
    ringSvg.classList.add('depth-rings');
    ringSvg.style.left = '-180px';
    ringSvg.style.bottom = '-160px';
    // NO filter here either

    let ringInner = `<circle cx="350" cy="350" r="3" fill="#ffcf40" opacity="0.7"/>`;
    const ringCount = 4;
    for (let i = 0; i < ringCount; i++) {
      ringInner += `<circle class="wave-ring" cx="350" cy="350" r="18" fill="none" stroke="#ffcf40" stroke-width="1.4"
        style="transform-origin: 350px 350px; animation: depth-ring-expand 9s ease-out infinite; animation-delay: ${(i * 9) / ringCount}s;"/>`;
    }
    ringSvg.innerHTML = ringInner;

    wrap.appendChild(sphereSvg);
    wrap.appendChild(ringSvg);

    // FIX: append to END of body, not insertBefore(firstChild).
    // Prepending placed this filtered element before the FAB/panel in
    // the DOM, which caused Chromium to break position:fixed on them.
    // Appending last means it never precedes any fixed element.
    document.body.appendChild(wrap);

    injectKeyframes();

    if (REDUCED_MOTION) {
      wrap.querySelectorAll('[style*="animation"]').forEach(el => {
        el.style.animation = 'none';
      });
    }
  }

  function injectKeyframes() {
    if (document.getElementById('depth-keyframes')) return;
    const style = document.createElement('style');
    style.id = 'depth-keyframes';
    style.textContent = `
      @keyframes depth-lon-spin {
        0%   { transform: scaleX(1); }
        25%  { transform: scaleX(0.05); }
        50%  { transform: scaleX(1); }
        75%  { transform: scaleX(0.05); }
        100% { transform: scaleX(1); }
      }
      @keyframes depth-ring-expand {
        0%   { transform: scale(0.3); opacity: 0; }
        12%  { opacity: 0.55; }
        70%  { opacity: 0.12; }
        100% { transform: scale(17); opacity: 0; }
      }
      .depth-bg svg { position: absolute; }
    `;
    document.head.appendChild(style);
  }

  /* ===================== SCROLLYTELLING REVEAL ===================== */

  function initScrollReveal() {
    const targets = document.querySelectorAll(
      '.bento-card, .gauge-card, .metrics-card, .table-card, .chart-card'
    );
    if (!targets.length) return;

    if (REDUCED_MOTION || !('IntersectionObserver' in window)) {
      targets.forEach(el => el.classList.add('reveal-in'));
      return;
    }

    targets.forEach(el => el.classList.add('reveal-pending'));

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const delay = (Number(el.dataset.revealIndex) || 0) * 45;
        setTimeout(() => el.classList.add('reveal-in'), delay);
        observer.unobserve(el);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    targets.forEach((el, i) => {
      el.dataset.revealIndex = Math.min(i, 8);
      observer.observe(el);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    buildDepthBackground();
    initScrollReveal();
  });
})();
