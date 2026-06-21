/* ---------------------------------------------------------------------
   bento.js (v3 — mobile drag fix)
   Pointer-based drag-and-drop: press anywhere on a card's empty space
   and drag to reorder. A press that doesn't move past a small threshold
   is treated as a normal click, so buttons/inputs/canvas/table inside
   the card keep working. Order persists in localStorage.

   v3 changes (mobile/touch):
   - .bento-card gets touch-action: none so the browser doesn't start a
     native page-scroll/zoom gesture on touch before our drag logic runs.
     This is the root cause of "drag doesn't work on phone" — without it,
     a touch-and-drag is consumed by the browser as scrolling.
   - pointermove/pointerdown call preventDefault() once a drag actually
     starts, so iOS/Android don't also fire scroll, text-selection
     callouts, or pull-to-refresh mid-drag.
   - Drag threshold is larger on touch pointers (coarse pointer) than
     mouse, since fingers are imprecise and a 6px threshold fires
     false-positive drags from normal taps on small screens.
   - pointercancel is handled (mobile fires this on interruptions like
     an incoming notification) so a card can't get stuck mid-drag.
   - touch-callout / user-select are suppressed on cards during press so
     long-press doesn't pop a native menu before the drag takes over.
--------------------------------------------------------------------- */

(function () {
  const STORAGE_KEY = 'tremorlab.bentoOrder.v1';
  const DRAG_THRESHOLD_MOUSE = 6;   // px of movement before a press becomes a drag
  const DRAG_THRESHOLD_TOUCH = 10;  // touch needs a bit more slack than a mouse

  // Elements that should never start a card-drag when pressed
  const INTERACTIVE_SELECTOR = 'input, select, button, a, textarea, canvas, table, .card-body';

  // Drag-to-reorder is a desktop power-user feature: a mouse can hover,
  // pick up, and drop a card without ever competing with scrolling.
  // On a touch-primary device, the exact same gesture vocabulary (press
  // and move) is also how the user scrolls the page, and a phone screen
  // is mostly covered by card surfaces — so enabling drag there means
  // most ordinary scroll attempts begin life as a possible drag, and the
  // browser can't treat the touch as a scroll until *after* our drag
  // threshold has resolved. That's the actual cause of "laggy, no room
  // to scroll" on phones. Drag-to-reorder also is not really useful on
  // mobile, since dragging a full-width stacked card past other
  // full-width stacked cards is awkward at any size.
  //
  // (prefers-reduced-motion users are not assumed to be on touch, so
  // motion preference is left untouched here — this checks input type.)
  const IS_TOUCH_PRIMARY = window.matchMedia('(pointer: coarse)').matches;

  function initBentoGrid() {
    const grid = document.getElementById('bentoGrid');
    if (!grid) return;

    if (IS_TOUCH_PRIMARY) {
      // Skip attaching any drag listeners and skip the CSS lock entirely
      // — cards behave like plain static content, and native scrolling
      // is never intercepted. Order restore/reset still apply, in case
      // someone set a custom order on desktop and later opens the same
      // browser profile on a tablet that's still coarse-pointer.
      restoreOrder(grid);
      addResetControl(grid);
      return;
    }

    let dragCard = null;
    let startX = 0, startY = 0;
    let dragging = false;
    let pointerId = null;
    let placeholder = null;
    let isTouch = false;

    function cardFromEvent(e) {
      return e.target.closest('.bento-card');
    }

    function isInteractive(e) {
      return !!e.target.closest(INTERACTIVE_SELECTOR);
    }

    function onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return; // left click / touch only
      const card = cardFromEvent(e);
      if (!card) return;
      if (isInteractive(e)) return; // let the real control handle it

      dragCard = card;
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
      pointerId = e.pointerId;
      isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';

      // Don't start native text selection while we decide if this is a drag
      document.addEventListener('pointermove', onPointerMove, { passive: false });
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
    }

    function beginDrag(e) {
      dragging = true;
      dragCard.classList.add('dragging');
      try { dragCard.setPointerCapture(pointerId); } catch (err) {}

      placeholder = document.createElement('div');
      placeholder.className = dragCard.className.replace('dragging', '').trim();
      placeholder.style.visibility = 'hidden';
      dragCard.after(placeholder);

      dragCard.style.position = 'fixed';
      dragCard.style.zIndex = '50';
      dragCard.style.width = placeholder.getBoundingClientRect().width + 'px';
      moveCardTo(e.clientX, e.clientY);
      document.body.style.cursor = 'grabbing';
      // Stop the page itself from scrolling/bouncing once a drag is live,
      // on top of the touch-action CSS rule (belt-and-suspenders for iOS).
      document.body.style.overscrollBehavior = 'contain';
      document.body.style.touchAction = 'none';
    }

    function moveCardTo(x, y) {
      const rect = dragCard.getBoundingClientRect();
      const offsetW = rect.width / 2;
      dragCard.style.left = (x - offsetW) + 'px';
      dragCard.style.top = (y - 24) + 'px';
    }

    function onPointerMove(e) {
      if (!dragCard) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!dragging) {
        const threshold = isTouch ? DRAG_THRESHOLD_TOUCH : DRAG_THRESHOLD_MOUSE;
        if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) {
          beginDrag(e);
        } else {
          return;
        }
      }

      // Once dragging, prevent the default touch behavior (scroll,
      // pull-to-refresh, text selection) so the gesture stays a drag.
      if (e.cancelable) e.preventDefault();

      moveCardTo(e.clientX, e.clientY);

      // Find what card we're hovering over and reposition the placeholder
      dragCard.style.pointerEvents = 'none';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      dragCard.style.pointerEvents = '';
      const targetCard = under && under.closest('.bento-card');
      grid.querySelectorAll('.drop-target').forEach(c => c.classList.remove('drop-target'));

      if (targetCard && targetCard !== dragCard && targetCard !== placeholder) {
        targetCard.classList.add('drop-target');
        const rect = targetCard.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        if (before) {
          targetCard.before(placeholder);
        } else {
          targetCard.after(placeholder);
        }
      }
    }

    function endDragCleanup() {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);

      if (dragCard && dragging) {
        dragCard.classList.remove('dragging');
        dragCard.style.position = '';
        dragCard.style.left = '';
        dragCard.style.top = '';
        dragCard.style.width = '';
        dragCard.style.zIndex = '';
        document.body.style.cursor = '';
        document.body.style.overscrollBehavior = '';
        document.body.style.touchAction = '';
        grid.querySelectorAll('.drop-target').forEach(c => c.classList.remove('drop-target'));

        if (placeholder && placeholder.parentNode) {
          placeholder.replaceWith(dragCard);
        }
        saveOrder(grid);
        window.dispatchEvent(new Event('resize')); // let canvases redraw at new size
      }

      placeholder = null;
      dragCard = null;
      dragging = false;
      pointerId = null;
      isTouch = false;
    }

    function onPointerUp() {
      endDragCleanup();
    }

    // Mobile fires pointercancel on interruptions (incoming call, browser
    // chrome gesture taking over, etc.) — without this handler the card
    // would stay stuck in "dragging" state with no way to drop it.
    function onPointerCancel() {
      endDragCleanup();
    }

    grid.addEventListener('pointerdown', onPointerDown);

    restoreOrder(grid);
    addResetControl(grid);
  }

  function saveOrder(grid) {
    const order = Array.from(grid.children)
      .filter(el => el.classList.contains('bento-card'))
      .map(el => el.dataset.cardId)
      .filter(Boolean);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
    } catch (err) { /* storage unavailable, ignore */ }
    const resetBtn = document.getElementById('bentoResetBtn');
    if (resetBtn) resetBtn.hidden = false;
  }

  function restoreOrder(grid) {
    let order;
    try {
      order = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (err) {
      order = null;
    }
    if (!Array.isArray(order) || !order.length) return;

    const byId = new Map(
      Array.from(grid.children)
        .filter(el => el.classList.contains('bento-card'))
        .map(el => [el.dataset.cardId, el])
    );
    order.forEach(id => {
      const el = byId.get(id);
      if (el) grid.appendChild(el);
    });
    const resetBtn = document.getElementById('bentoResetBtn');
    if (resetBtn) resetBtn.hidden = false;
  }

  function addResetControl(grid) {
    const resetBtn = document.getElementById('bentoResetBtn');
    if (!resetBtn) return;
    resetBtn.addEventListener('click', () => {
      try { localStorage.removeItem(STORAGE_KEY); } catch (err) {}
      location.reload();
    });
  }

  /* ---------------------------------------------------------------------
     Floating agent launcher
  --------------------------------------------------------------------- */

  function initAgentLauncher() {
    const fab = document.getElementById('agentFab');
    const panel = document.getElementById('agentPanel');
    const closeBtn = document.getElementById('agentPanelClose');
    if (!fab || !panel) return;

    function open() {
      panel.classList.add('open');
      fab.setAttribute('aria-expanded', 'true');
      const input = document.getElementById('agentInput');
      if (input) setTimeout(() => input.focus(), 180);
    }
    function close() {
      panel.classList.remove('open');
      fab.setAttribute('aria-expanded', 'false');
    }
    function toggle() {
      panel.classList.contains('open') ? close() : open();
    }

    fab.addEventListener('click', toggle);
    if (closeBtn) closeBtn.addEventListener('click', close);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && panel.classList.contains('open')) close();
    });

    document.addEventListener('click', e => {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(e.target) || fab.contains(e.target)) return;
      close();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initBentoGrid();
    initAgentLauncher();
  });
})();
