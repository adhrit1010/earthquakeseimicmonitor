/* ---------------------------------------------------------------------
   depth.js
   Two independent jobs, kept separate so either can be dropped without
   breaking the other:

   1. buildDepthBackground() — injects one ambient SVG into the page,
      behind everything (.depth-bg, z-index 0). It's a slow-rotating
      wireframe sphere (latitude/longitude mesh, like a globe a
      hypocenter sits inside) plus a few concentric "wavefront" rings
      that drift outward and fade — both rendered as thin gold
      strokes only, so it reads as instrumentation, not decoration.
      Pure SVG/CSS animation, no canvas loop, no JS per-frame cost.

   2. initScrollReveal() — IntersectionObserver that adds .reveal-in to
      cards as they enter the viewport, staggered slightly per card.
      Cards start tagged .reveal-pending in HTML-less fashion (added
      here at init) so there's no flash-of-unstyled-content if this
      script loads slightly after first paint.
--------------------------------------------------------------------- */

(function () {
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ===================== AMBIENT GOLD WIREFRAME ===================== */

  function buildDepthBackground() {
    if (document.querySelector('.depth-bg')) return; // don't double-inject on hot reload
    const wrap = document.createElement('div');
    wrap.className = 'depth-bg';
    wrap.setAttribute('aria-hidden', 'true');

    // ---- Sphere: latitude/longitude wireframe, slow Y-axis spin ----
    // Built as a set of ellipses standing in for great-circle lines,
    // viewed from a fixed angle — cheap, no real 3D math needed since
    // the rotation is just animating each ellipse's rx over time to
    // fake parallax (a classic 2D-wireframe-globe trick).
    const sphereSize = 520;
    const sphereSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sphereSvg.setAttribute('viewBox', `0 0 ${sphereSize} ${sphereSize}`);
    sphereSvg.setAttribute('width', sphereSize);
    sphereSvg.setAttribute('height', sphereSize);
    sphereSvg.classList.add('depth-sphere');
    sphereSvg.style.right = '-120px';
    sphereSvg.style.top = '8%';

    const cx = sphereSize / 2;
    const cy = sphereSize / 2;
    const r = sphereSize / 2 - 12;

    let sphereInner = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e8c468" stroke-width="1" opacity="0.55"/>`;

    // Latitude lines: horizontal ellipses at varying heights, flattened
    const latCount = 5;
    for (let i = 1; i < latCount; i++) {
      const t = i / latCount; // 0..1
      const yOff = (t - 0.5) * 2 * r;
      const ellipseRx = r;
      const ellipseRy = Math.max(2, r * 0.18) * (1 - Math.abs(t - 0.5) * 0.6);
      sphereInner += `<ellipse class="lat-line" data-base-ry="${ellipseRy.toFixed(2)}" cx="${cx}" cy="${(cy + yOff).toFixed(2)}" rx="${ellipseRx.toFixed(2)}" ry="${ellipseRy.toFixed(2)}" fill="none" stroke="#e8c468" stroke-width="0.75" opacity="0.4"/>`;
    }

    // Longitude lines: vertical ellipses, rx animates to fake rotation
    const lonCount = 6;
    for (let i = 0; i < lonCount; i++) {
      const phase = (i / lonCount) * Math.PI;
      sphereInner += `<ellipse class="lon-line" data-phase="${phase.toFixed(3)}" cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" fill="none" stroke="#e8c468" stroke-width="0.75" opacity="0.4" transform="rotate(0 ${cx} ${cy})"/>`;
    }

    sphereSvg.innerHTML = sphereInner;

    // Apply the longitude "rotation" by scaling rx per-ellipse via CSS
    // custom animation (handled below with a JS rAF-free CSS approach):
    // each lon-line gets a unique animation-delay so a single shared
    // keyframe (squash rx 1 -> 0.05 -> 1) reads as independent meridians
    // sweeping across the sphere as it spins.
    sphereSvg.querySelectorAll('.lon-line').forEach((el, i) => {
      el.style.transformOrigin = `${cx}px ${cy}px`;
      el.style.animation = `depth-lon-spin 22s linear infinite`;
      el.style.animationDelay = `${(i / lonCount) * -22}s`;
    });

    // ---- Wavefront rings: concentric circles drifting outward + fading,
    // standing in for a P-wave radiating from a hypocenter. Lower-left,
    // away from the sphere, so the two elements don't visually collide. ----
    const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ringSvg.setAttribute('viewBox', '0 0 700 700');
    ringSvg.setAttribute('width', 700);
    ringSvg.setAttribute('height', 700);
    ringSvg.classList.add('depth-rings');
    ringSvg.style.left = '-180px';
    ringSvg.style.bottom = '-160px';

    let ringInner = `<circle cx="350" cy="350" r="3" fill="#e8c468" opacity="0.7"/>`;
    const ringCount = 4;
    for (let i = 0; i < ringCount; i++) {
      ringInner += `<circle class="wave-ring" cx="350" cy="350" r="20" fill="none" stroke="#e8c468" stroke-width="1" opacity="0"
        style="animation: depth-ring-expand 9s ease-out infinite; animation-delay: ${(i * 9) / ringCount}s;"/>`;
    }
    ringSvg.innerHTML = ringInner;

    wrap.appendChild(sphereSvg);
    wrap.appendChild(ringSvg);
    document.body.insertBefore(wrap, document.body.firstChild);

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
        0%   { r: 16; opacity: 0; stroke-width: 1.4; }
        12%  { opacity: 0.5; }
        70%  { opacity: 0.12; }
        100% { r: 320; opacity: 0; stroke-width: 0.4; }
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

    // Stagger by document order within each row-ish cluster, cheaply:
    // index by position in the NodeList, capped so late cards on long
    // pages don't wait seconds to appear.
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
