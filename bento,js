/* ---------------------------------------------------------------------
   bento.js
   Makes .bento-card elements inside #bentoGrid draggable and reorderable.
   Persists card order in localStorage (this is a real deployed page,
   not a sandboxed artifact, so localStorage is fine here).
   Also wires the floating agent launcher (.agent-fab) to open/close
   the existing agent panel without changing app.js's chat logic at all.
--------------------------------------------------------------------- */

(function () {
  const STORAGE_KEY = 'tremorlab.bentoOrder.v1';

  function initBentoGrid() {
    const grid = document.getElementById('bentoGrid');
    if (!grid) return;

    const cards = Array.from(grid.querySelectorAll('.bento-card'));
    cards.forEach(addHandle);

    let dragged = null;

    cards.forEach(card => {
      const handle = card.querySelector('.bento-handle');
      if (!handle) return;

      handle.addEventListener('mousedown', () => { card.draggable = true; });
      handle.addEventListener('mouseup', () => { card.draggable = false; });
      handle.addEventListener('touchstart', () => { card.draggable = true; }, { passive: true });

      card.addEventListener('dragstart', e => {
        dragged = card;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', card.dataset.cardId || ''); } catch (err) {}
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        card.draggable = false;
        grid.querySelectorAll('.drop-target').forEach(c => c.classList.remove('drop-target'));
        saveOrder(grid);
      });

      card.addEventListener('dragover', e => {
        e.preventDefault();
        if (!dragged || dragged === card) return;
        card.classList.add('drop-target');
      });

      card.addEventListener('dragleave', () => {
        card.classList.remove('drop-target');
      });

      card.addEventListener('drop', e => {
        e.preventDefault();
        card.classList.remove('drop-target');
        if (!dragged || dragged === card) return;
        const cardsNow = Array.from(grid.children);
        const draggedIdx = cardsNow.indexOf(dragged);
        const targetIdx = cardsNow.indexOf(card);
        if (draggedIdx < targetIdx) {
          card.after(dragged);
        } else {
          card.before(dragged);
        }
        window.dispatchEvent(new Event('resize')); // let canvases redraw at new size
      });
    });

    restoreOrder(grid);
    addResetControl(grid);
  }

  function addHandle(card) {
    if (card.querySelector('.bento-handle')) return;
    const handle = document.createElement('button');
    handle.className = 'bento-handle';
    handle.type = 'button';
    handle.setAttribute('aria-label', 'Drag to reorder this card');
    handle.innerHTML = `
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="3" r="1.3"/><circle cx="11" cy="3" r="1.3"/>
        <circle cx="5" cy="8" r="1.3"/><circle cx="11" cy="8" r="1.3"/>
        <circle cx="5" cy="13" r="1.3"/><circle cx="11" cy="13" r="1.3"/>
      </svg>`;
    card.appendChild(handle);
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
