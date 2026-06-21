/* ---------------------------------------------------------------------
   bento.js (v2)
   Pointer-based drag-and-drop: press anywhere on a card's empty space
   and drag to reorder. A press that doesn't move past a small threshold
   is treated as a normal click, so buttons/inputs/canvas/table inside
   the card keep working. Order persists in localStorage.
--------------------------------------------------------------------- */

(function () {
  const STORAGE_KEY = 'tremorlab.bentoOrder.v1';
  const DRAG_THRESHOLD = 6; // px of movement before a press becomes a drag

  // Elements that should never start a card-drag when pressed
  const INTERACTIVE_SELECTOR = 'input, select, button, a, textarea, canvas, table, .card-body';

  function initBentoGrid() {
    const grid = document.getElementById('bentoGrid');
    if (!grid) return;

    let dragCard = null;
    let startX = 0, startY = 0;
    let dragging = false;
    let pointerId = null;
    let placeholder = null;

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

      // Don't start native text selection while we decide if this is a drag
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
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
        if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
          beginDrag(e);
        } else {
          return;
        }
      }

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

    function onPointerUp() {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);

      if (dragCard && dragging) {
        dragCard.classList.remove('dragging');
        dragCard.style.position = '';
        dragCard.style.left = '';
        dragCard.style.top = '';
        dragCard.style.width = '';
        dragCard.style.zIndex = '';
        document.body.style.cursor = '';
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
