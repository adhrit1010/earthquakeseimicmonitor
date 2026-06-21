/* ---------------------------------------------------------------------
   bento.js (v5 — scroll-jump fix only; portal removed)

   The FAB and panel are direct children of <body> in index.html, so
   position:fixed works correctly without a portal wrapper. The portal
   approach in v4 introduced a new containing block that caused the
   panel to left-anchor instead of right-anchor.

   v5 changes vs original:
   - focus() uses { preventScroll: true } so opening the panel on
     desktop doesn't jump the page to the input element.
   - Portal logic removed entirely; DOM structure unchanged.
   - All other drag/reorder/mobile logic identical to v3.
--------------------------------------------------------------------- */

(function () {
  const STORAGE_KEY = 'tremorlab.bentoOrder.v1';
  const DRAG_THRESHOLD_MOUSE = 6;
  const DRAG_THRESHOLD_TOUCH = 10;

  const INTERACTIVE_SELECTOR = 'input, select, button, a, textarea, canvas, table, .card-body';

  const IS_TOUCH_PRIMARY = window.matchMedia('(pointer: coarse)').matches;

  function initBentoGrid() {
    const grid = document.getElementById('bentoGrid');
    if (!grid) return;

    if (IS_TOUCH_PRIMARY) {
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
      if (e.button !== undefined && e.button !== 0) return;
      const card = cardFromEvent(e);
      if (!card) return;
      if (isInteractive(e)) return;

      dragCard = card;
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
      pointerId = e.pointerId;
      isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';

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

      if (e.cancelable) e.preventDefault();
      moveCardTo(e.clientX, e.clientY);

      dragCard.style.pointerEvents = 'none';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      dragCard.style.pointerEvents = '';
      const targetCard = under && under.closest('.bento-card');
      grid.querySelectorAll('.drop-target').forEach(c => c.classList.remove('drop-target'));

      if (targetCard && targetCard !== dragCard && targetCard !== placeholder) {
        targetCard.classList.add('drop-target');
        const rect = targetCard.getBoundingClientRect();
        const before = e.clientX < rect.left + rect.width / 2;
        if (before) targetCard.before(placeholder);
        else targetCard.after(placeholder);
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
        window.dispatchEvent(new Event('resize'));
      }

      placeholder = null;
      dragCard = null;
      dragging = false;
      pointerId = null;
      isTouch = false;
    }

    function onPointerUp() { endDragCleanup(); }
    function onPointerCancel() { endDragCleanup(); }

    grid.addEventListener('pointerdown', onPointerDown);
    restoreOrder(grid);
    addResetControl(grid);
  }

  function saveOrder(grid) {
    const order = Array.from(grid.children)
      .filter(el => el.classList.contains('bento-card'))
      .map(el => el.dataset.cardId)
      .filter(Boolean);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); } catch (err) {}
    const resetBtn = document.getElementById('bentoResetBtn');
    if (resetBtn) resetBtn.hidden = false;
  }

  function restoreOrder(grid) {
    let order;
    try { order = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (err) { order = null; }
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

  /* ===================== FLOATING AGENT LAUNCHER ===================== */

  function initAgentLauncher() {
    const fab = document.getElementById('agentFab');
    const panel = document.getElementById('agentPanel');
    const closeBtn = document.getElementById('agentPanelClose');
    if (!fab || !panel) return;

    function open() {
      panel.classList.add('open');
      fab.setAttribute('aria-expanded', 'true');
      const input = document.getElementById('agentInput');
      if (input) {
        setTimeout(() => {
          // preventScroll: true stops the browser from jumping the
          // page to the input element when the panel opens on desktop.
          input.focus({ preventScroll: true });
        }, 180);
      }
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
