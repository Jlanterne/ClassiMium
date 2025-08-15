/* plan_classe.js — précision figée 1/32, drag-only, collapse au contact,
   dead-zones fix, resize 4 coins, rotation absolue (élèves & meubles)
   prénom lisible à 180°, empreinte tournée (90/270) pour collisions,
   anti-duplications lors des autosaves
*/

(() => {
  const $stage = document.getElementById('pc_stage');
  if (!$stage) return;

  // ========= Config / état =========
  const conf = window.SEATING_CONF || {};
  const classeId = conf.classeId || parseInt($stage.dataset.classeId, 10);
  const API_BASE = (conf.apiBase || "/seating") + "/api";
  const PHOTOS_BASE = conf.photosBase || "/static/photos/";

  // Précision figée : 1/32 — UI & stockage identiques
  let UI_SUBDIV = 32;
  let PLAN_SUBDIV = 32;

  // Taille d’une unité (px) — déterminée par l’autofit
  let unitPx = 32;

  // ids temporaires pour les nouveaux meubles (avant retour API)
  let tempIdSeq = -1;

  // Anti-duplication : ne pas réémettre plusieurs fois les mêmes nouveaux meubles
  const sentNewFurniture = new Set(); // uid → déjà envoyé dans une autosave
  function genUid() { return 'f_' + Math.random().toString(36).slice(2, 10); }

  // État global
  let state = {
    plans: [], active_plan: null,
    furniture: [], positions: [], seats: [], eleves: []
  };

  // Couleurs par type (modifiable via palette)
  const FURN_DEF_COLORS = {
    desk: "#f1e7db", table_rect: "#fffef7", table_round: "#fffef7",
    armoire: "#d7c5ad", board: "#0f5132", door: "#b87333",
    window: "#cfe8ff", sink: "#e5e7eb", trash: "#475569", plant: "#def7ec"
  };
  const FURN_COLORS = { ...FURN_DEF_COLORS };

  // ========= DOM =========
  const $sel = document.getElementById('pc_plan_select');
  const $new = document.getElementById('pc_new_plan');
  const $dup = document.getElementById('pc_duplicate');
  const $act = document.getElementById('pc_activate');
  const $pdf = document.getElementById('pc_export_pdf');
  const $full = document.getElementById('pc_fullscreen');
  const $elist = document.getElementById('pc_eleve_list');
  const $wrap = $stage.parentElement;
  const $reset = document.getElementById('pc_reset_plan');
  const $palette = document.getElementById('pc_furn_palette');
  const $subdiv = document.getElementById('pc_subdiv'); // ignoré (précision figée)
  try { $subdiv?.closest('label')?.style && ($subdiv.closest('label').style.display = 'none'); } catch { }

  // ========= utils =========
  const EPS = 1e-6;
  const TICK = 1 / UI_SUBDIV;
  const DRAG_THRESHOLD = 6; // px, pour distinguer clic vs drag

  // px ⇄ unités (sans arrondis dangereux)
  const toPx = u => u * unitPx;
  const snapUnits = v => Math.round(v * UI_SUBDIV) / UI_SUBDIV;

  function stageInnerBox() {
    const r = $stage.getBoundingClientRect();
    const cs = getComputedStyle($stage);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    const left = r.left + bl, top = r.top + bt;
    const width = r.width - bl - br, height = r.height - bt - bb;
    return { left, top, width, height };
  }
  function isPointInStage(clientX, clientY) {
    const b = stageInnerBox();
    return clientX >= b.left && clientX <= (b.left + b.width) &&
      clientY >= b.top && clientY <= (b.top + b.height);
  }

  // rotation helpers (empreinte tournée par pas de 90°)
  function normDeg(a) { let d = a % 360; if (d < 0) d += 360; return d; }
  function isQuarterTurnSwap(deg) { const q = Math.round(normDeg(deg) / 90) % 4; return (q % 2) === 1; } // 90°/270° → swap w/h

  // clientX/Y → unités clampées (marge = taille objet), snapped au tick
  function clientToUnitsClamped(clientX, clientY, wUnits = 0, hUnits = 0) {
    const box = stageInnerBox();
    const xpx = Math.min(box.left + box.width - 0.001, Math.max(box.left, clientX));
    const ypx = Math.min(box.top + box.height - 0.001, Math.max(box.top, clientY));
    let ux = snapUnits((xpx - box.left) / unitPx);
    let uy = snapUnits((ypx - box.top) / unitPx);
    if (state.active_plan) {
      const W = state.active_plan.width, H = state.active_plan.height;
      const minX = Math.max(TICK, wUnits || 0);
      const minY = Math.max(TICK, hUnits || 0);
      ux = Math.max(0, Math.min(ux, W - minX));
      uy = Math.max(0, Math.min(uy, H - minY));
    }
    return { x: ux, y: uy };
  }

  // Empreinte (carré 96px) d’une carte élève en unités, arrondie au tick
  function footprintCardUnits() {
    const units = Math.ceil((96 / unitPx) * UI_SUBDIV) / UI_SUBDIV;
    const u = Math.max(TICK, units);
    return { w: u, h: u };
  }

  // ========= API =========
  const api = {
    getAll: () => fetch(`${API_BASE}/plans/${classeId}`).then(r => r.json()),
    create: (payload) => fetch(`${API_BASE}/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json()),
    activate: (plan_id) => fetch(`${API_BASE}/plans/${plan_id}/activate`, { method: 'PUT' }).then(r => r.json()),
    duplicate: (plan_id) => fetch(`${API_BASE}/plans/${plan_id}/duplicate`, { method: 'POST' }).then(r => r.json()),
    reset: (plan_id, full = false) => fetch(`${API_BASE}/plans/${plan_id}/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full: !!full }) }).then(r => r.json()),
    savePositions: (plan_id, items) => fetch(`${API_BASE}/plans/${plan_id}/positions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ positions: items }) }).then(r => r.json()),
    deletePosition: (plan_id, eleve_id) => fetch(`${API_BASE}/plans/${plan_id}/positions`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eleve_id }) }).then(r => r.json()),
    saveFurniture: (plan_id, items) => fetch(`${API_BASE}/plans/${plan_id}/furniture`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ furniture: items }) }).then(r => r.json()),
    deleteFurniture: (plan_id, item_id) => fetch(`${API_BASE}/plans/${plan_id}/furniture/${item_id}`, { method: 'DELETE' }).then(r => r.json()),
  };

  // ========= autosave =========
  const debounce = (fn, d = 600) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); }; };

  const autosavePositions = debounce(() => {
    if (!state.active_plan) return;
    const payload = state.positions.map(p => ({
      eleve_id: p.eleve_id,
      x: Math.round(p.x * PLAN_SUBDIV),
      y: Math.round(p.y * PLAN_SUBDIV),
      seat_id: p.seat_id ?? null,
      rot: Math.round((p.rotAbs ?? p.rot ?? 0) % 360)
    }));
    api.savePositions(state.active_plan.id, payload).catch(console.error);
  }, 600);

  const autosaveFurniture = debounce(() => {
    if (!state.active_plan) return;

    // n’émet PAS les nouveaux meubles déjà émis (tant que boot() n’a pas resync)
    const payload = state.furniture
      .filter(f => (f.id > 0) || (f.id <= 0 && !sentNewFurniture.has(f.uid)))
      .map(f => ({
        id: (f.id && f.id > 0) ? f.id : undefined,
        client_uid: f.uid ?? null,
        type: f.type,
        label: f.label,
        color: f.color || FURN_COLORS[f.type] || null,
        x: Math.round(f.x * PLAN_SUBDIV),
        y: Math.round(f.y * PLAN_SUBDIV),
        w: Math.round(f.w * PLAN_SUBDIV),
        h: Math.round(f.h * PLAN_SUBDIV),
        rotation: Math.round((f.rotAbs ?? f.rotation ?? 0) % 360),
        z: f.z || 0
      }));

    if (payload.length === 0) return;

    const justSentUids = new Set(payload.filter(p => !p.id && p.client_uid).map(p => p.client_uid));
    justSentUids.forEach(uid => sentNewFurniture.add(uid));

    api.saveFurniture(state.active_plan.id, payload).catch(err => {
      console.error(err);
      justSentUids.forEach(uid => sentNewFurniture.delete(uid));
    });
  }, 600);

  function saveAllNow() { autosavePositions(); autosaveFurniture(); }

  // ========= Auto-fit (pas de zoom CSS) =========
  function fitStageToWrap() {
    if (!state.active_plan) return;

    const planW = state.active_plan.width;
    const planH = state.active_plan.height;

    const toolbarH = (document.querySelector('.pc_toolbar')?.offsetHeight || 52);
    const pagePad = 16;
    const verticalGap = 16;
    const availH = Math.max(120, window.innerHeight - toolbarH - pagePad - verticalGap);
    const availW = Math.max(160, $wrap.clientWidth - 20);

    unitPx = Math.max(4, Math.min(availW / planW, availH / planH));

    $stage.style.width = `${planW * unitPx}px`;
    $stage.style.height = `${planH * unitPx}px`;
    $wrap.style.maxHeight = `${availH}px`;

    const sub = Math.max(1, unitPx / UI_SUBDIV);
    $stage.style.backgroundImage =
      `linear-gradient(to right, rgba(0,0,0,.06) 1px, transparent 1px),
       linear-gradient(to bottom, rgba(0,0,0,.06) 1px, transparent 1px),
       linear-gradient(to right, rgba(0,0,0,.15) 1px, transparent 1px),
       linear-gradient(to bottom, rgba(0,0,0,.15) 1px, transparent 1px)`;
    $stage.style.backgroundSize =
      `${sub}px ${sub}px, ${sub}px ${sub}px, ${unitPx}px ${unitPx}px, ${unitPx}px ${unitPx}px`;
  }

  // ========= collisions / bornes =========
  function clampToStage(gx, gy, wUnits, hUnits) {
    if (!state.active_plan) return { gx, gy };
    const W = state.active_plan.width, H = state.active_plan.height;
    return { gx: Math.max(0, Math.min(gx, W - wUnits)), gy: Math.max(0, Math.min(gy, H - hUnits)) };
  }

  // rectangles “axis-aligned” en unités (élèves = carré 96px)
  function rectsInPlan(exclude = {}) {
    const rects = [];
    const fp = footprintCardUnits();
    for (const p of state.positions) {
      if (exclude.eleveId && p.eleve_id === exclude.eleveId) continue;
      rects.push({ x: p.x, y: p.y, w: fp.w, h: fp.h, kind: 'eleve', id: p.eleve_id });
    }
    for (const f of state.furniture) {
      if (exclude.furnitureId && f.id === exclude.furnitureId) continue;
      const rot = (f.rotAbs ?? f.rotation ?? 0);
      const swap = isQuarterTurnSwap(rot);
      const wEff = swap ? f.h : f.w;
      const hEff = swap ? f.w : f.h;
      rects.push({ x: f.x, y: f.y, w: wEff, h: hEff, kind: 'furniture', id: f.id });
    }
    return rects;
  }

  function notOverlap(a, b) {
    if ((a.x + a.w) <= b.x + EPS) return true;
    if ((b.x + b.w) <= a.x + EPS) return true;
    if ((a.y + a.h) <= b.y + EPS) return true;
    if ((b.y + b.h) <= a.y + EPS) return true;
    return false;
  }
  function collides(r, others) { for (const o of others) if (!notOverlap(r, o)) return true; return false; }

  // “collapse” : si un bord est à ≤1 tick d’un autre et que l’autre axe chevauche, on aligne
  function snapCollapse(r, others) {
    const margin = TICK + 1e-9;
    const overlap1D = (a0, a1, b0, b1) => !(a1 <= b0 + EPS || b1 <= a0 + EPS);
    let best = null;

    for (const o of others) {
      // collage horizontal si chevauchement vertical
      if (overlap1D(r.y, r.y + r.h, o.y, o.y + o.h)) {
        const dx1 = o.x - (r.x + r.w);             // r droite → o gauche
        const dx2 = (o.x + o.w) - r.x;             // r gauche ← o droite
        if (Math.abs(dx1) <= margin) best = chooseBest(best, { dx: dx1, dy: 0 });
        if (Math.abs(dx2) <= margin) best = chooseBest(best, { dx: dx2, dy: 0 });
      }
      // collage vertical si chevauchement horizontal
      if (overlap1D(r.x, r.x + r.w, o.x, o.x + o.w)) {
        const dy1 = o.y - (r.y + r.h);             // r bas → o haut
        const dy2 = (o.y + o.h) - r.y;             // r haut ← o bas
        if (Math.abs(dy1) <= margin) best = chooseBest(best, { dx: 0, dy: dy1 });
        if (Math.abs(dy2) <= margin) best = chooseBest(best, { dx: 0, dy: dy2 });
      }
    }
    if (!best) return r;

    const cand = {
      x: snapUnits(r.x + best.dx),
      y: snapUnits(r.y + best.dy),
      w: r.w, h: r.h
    };
    const c = clampToStage(cand.x, cand.y, r.w, r.h);
    const snapped = { x: c.gx, y: c.gy, w: r.w, h: r.h };
    if (!collides(snapped, others)) return snapped;
    return r;

    function chooseBest(cur, nxt) {
      if (!cur) return nxt;
      const cd = Math.abs(cur.dx) + Math.abs(cur.dy);
      const nd = Math.abs(nxt.dx) + Math.abs(nxt.dy);
      return (nd < cd) ? nxt : cur;
    }
  }

  // Recherche la 1ère place libre proche (spirale), contact autorisé
  function findNearestFreeSpot(gx, gy, wUnits, hUnits, exclude = {}) {
    const others = rectsInPlan(exclude);
    const tryPlace = (x, y) => {
      const c = clampToStage(x, y, wUnits, hUnits);
      const r = { x: c.gx, y: c.gy, w: wUnits, h: hUnits };
      return collides(r, others) ? null : r;
    };

    let r = tryPlace(gx, gy); if (r) return r;
    const maxR = 80;
    for (let d = 1; d <= maxR; d++) {
      for (let dx = -d; dx <= d; dx++) {
        for (let dy = -d; dy <= d; dy++) {
          if (Math.abs(dx) !== d && Math.abs(dy) !== d) continue; // couronne
          const x = snapUnits(gx + dx * TICK);
          const y = snapUnits(gy + dy * TICK);
          r = tryPlace(x, y); if (r) return r;
        }
      }
    }
    return null;
  }

  function shake(el) { el.classList.add('pc_shake'); setTimeout(() => el.classList.remove('pc_shake'), 250); }

  // ========= rendu =========
  function renderPlansSelect() {
    if (!$sel) return; $sel.innerHTML = '';
    for (const p of state.plans) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = (p.is_active ? '★ ' : '') + `${p.name} — ${new Date(p.created_at).toLocaleDateString()}`;
      if (state.active_plan && p.id === state.active_plan.id) o.selected = true;
      $sel.appendChild(o);
    }
  }
  function clearStage() { $stage.querySelectorAll('.pc_card, .pc_furn').forEach(n => n.remove()); }

  function moyClass(m20) { if (m20 == null) return ''; if (m20 >= 16) return 'mAp'; if (m20 >= 13) return 'mA'; if (m20 >= 8) return 'mPA'; return 'mNA'; }

  // ===== rotation élève (angle absolu) + prénom lisible à 180° =====
  function setCardRotation(card, deltaDeg) {
    const abs = (parseFloat(card.dataset.rotAbs || card.dataset.rot || '0') || 0) + deltaDeg;
    card.dataset.rotAbs = String(abs);
    const inner = card.querySelector('.pc_card_in');
    const name = card.querySelector('.pc_name_in');
    if (inner) inner.style.transform = `rotate(${abs}deg)`;
    if (name) {
      const d = ((abs % 360) + 360) % 360;
      name.style.transform = (d > 135 && d < 225) ? 'rotate(180deg)' : 'rotate(0deg)';
    }
    const id = parseInt(card.dataset.eleveId, 10);
    const p = state.positions.find(p => p.eleve_id === id);
    if (p) { p.rotAbs = abs; p.rot = abs % 360; autosavePositions(); }
  }
  function addRotateButton(card) {
    const btn = document.createElement('div');
    btn.className = 'pc_delete_btn'; btn.style.right = '26px'; btn.title = 'Pivoter (90°) — Alt+molette: rotation fine'; btn.textContent = '↻';
    btn.addEventListener('click', (e) => { e.stopPropagation(); setCardRotation(card, 90); });
    card.addEventListener('wheel', (e) => { if (!e.altKey) return; e.preventDefault(); setCardRotation(card, (e.deltaY > 0 ? -5 : 5)); }, { passive: false });
    card.appendChild(btn);
  }

  function addCard(eleve, pos) {
    const card = document.createElement('div');
    card.className = 'pc_card';
    card.dataset.type = 'eleve';
    card.dataset.id = eleve.id;
    card.dataset.eleveId = eleve.id;
    if (eleve.sexe) card.dataset.sexe = eleve.sexe;
    if (eleve.niveau) card.dataset.niveau = eleve.niveau;
    card.dataset.prenom = eleve.prenom || '';
    if (pos.rot != null) { card.dataset.rot = String(pos.rot); card.dataset.rotAbs = String(pos.rot); }

    card.style.left = `${toPx(pos.x)}px`;
    card.style.top = `${toPx(pos.y)}px`;
    card.title = `${eleve.prenom || ''} ${eleve.nom || ''}`;

    const inner = document.createElement('div');
    inner.className = 'pc_card_in';
    inner.style.transform = `rotate(${card.dataset.rotAbs || card.dataset.rot || 0}deg)`;

    const img = document.createElement('img');
    img.src = PHOTOS_BASE + (eleve.photo_filename || 'default.jpg');
    img.draggable = card.draggable = false;
    img.addEventListener('dragstart', ev => ev.preventDefault());
    card.addEventListener('dragstart', ev => ev.preventDefault());

    const name = document.createElement('div');
    name.className = 'pc_name_in';
    name.textContent = eleve.prenom || '';
    (function () {
      const abs = parseFloat(card.dataset.rotAbs || '0') || 0;
      const d = ((abs % 360) + 360) % 360;
      name.style.transform = (d > 135 && d < 225) ? 'rotate(180deg)' : 'rotate(0deg)';
    })();

    const bSex = document.createElement('div');
    bSex.className = 'badge sex';
    bSex.textContent = (eleve.sexe === 'MASCULIN' ? '♂' : eleve.sexe === 'FEMININ' ? '♀' : '?');

    const bM = document.createElement('div');
    bM.className = `badge moy ${moyClass(eleve.moyenne_20)}`;
    bM.textContent = (eleve.moyenne_20 != null) ? Math.round(eleve.moyenne_20) : '—';

    inner.append(img, name);
    card.append(inner, bSex, bM);
    addDeleteButton(card);
    addRotateButton(card);

    card.addEventListener('pointerdown', startDragCard);
    $stage.appendChild(card);
  }

  function renderEleveList() {
    if (!$elist) return; $elist.innerHTML = '';
    const placed = new Set(state.positions.map(p => p.eleve_id));
    for (const e of state.eleves) {
      if (placed.has(e.id)) continue;
      const item = document.createElement('div'); item.className = 'pc_eleve_item'; item.dataset.eleveId = e.id; item.draggable = false;
      const img = document.createElement('img'); img.src = PHOTOS_BASE + (e.photo_filename || 'default.jpg'); img.draggable = false;
      const name = document.createElement('div'); name.className = 'name'; name.textContent = `${e.prenom} ${e.nom}`;
      item.append(img, name);
      // ajout uniquement en drag & drop
      item.addEventListener('pointerdown', startDragFromList);
      $elist.appendChild(item);
    }
  }

  // ===== helpers couleur meubles =====
  function hexToRgb(hex) { const x = hex.replace('#', ''); const n = parseInt(x.length === 3 ? x.split('').map(c => c + c).join('') : x, 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
  function darken(hex, pct = .22) { const { r, g, b } = hexToRgb(hex); const d = c => Math.max(0, Math.round(c * (1 - pct))); const h = n => n.toString(16).padStart(2, '0'); return `#${h(d(r))}${h(d(g))}${h(d(b))}`; }
  function applyFurnitureColor(el, type, color) {
    if (!color) return;
    el.style.background = color;
    el.style.borderColor = darken(color, .22);
    const lab = el.querySelector('.label');
    if (lab) {
      const { r, g, b } = hexToRgb(color); const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lab.style.color = (lum < 140) ? '#fff' : '#0f172a';
      lab.style.background = (lum < 140) ? 'rgba(0,0,0,.25)' : 'rgba(255,255,255,.85)';
      lab.style.borderColor = (lum < 140) ? 'rgba(255,255,255,.25)' : 'rgba(0,0,0,.08)';
    }
  }

  // ===== rotation meuble =====
  function setFurnitureRotation(el, delta) {
    const abs = (parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0) + delta;
    el.dataset.rotAbs = String(abs);
    el.style.transform = `rotate(${abs}deg)`;
    const id = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
    const f = (id != null) ? state.furniture.find(x => x.id === id) : null;
    if (f) { f.rotAbs = abs; f.rotation = abs % 360; autosaveFurniture(); }
  }
  function addFurnRotate(el) {
    const btn = document.createElement('div');
    btn.className = 'pc_delete_btn'; btn.style.right = '26px'; btn.title = 'Pivoter (90°) — Alt+molette: rotation fine'; btn.textContent = '↻';
    btn.addEventListener('click', (e) => { e.stopPropagation(); setFurnitureRotation(el, 90); });
    el.addEventListener('wheel', (e) => { if (!e.altKey) return; e.preventDefault(); setFurnitureRotation(el, (e.deltaY > 0 ? -5 : 5)); }, { passive: false });
    el.appendChild(btn);
  }

  // ===== meubles rendu =====
  function renderFurniture() {
    for (const f of (state.furniture || [])) {
      const el = document.createElement('div'); el.className = 'pc_furn'; el.dataset.type = 'furniture';
      el.dataset.id = (f.id != null) ? String(f.id) : '';
      const t = (f.type || 'autre').toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/\s+/g, '_');
      el.dataset.furnitureType = t;
      el.classList.add(`type-${t}`);
      if (f.rotation != null) el.dataset.rot = String(f.rotation);
      if (f.rotAbs != null) el.dataset.rotAbs = String(f.rotAbs);

      el.style.left = `${toPx(f.x)}px`;
      el.style.top = `${toPx(f.y)}px`;
      el.style.width = `${toPx(f.w)}px`;
      el.style.height = `${toPx(f.h)}px`;
      el.style.transformOrigin = 'center center';
      el.style.transform = `rotate(${el.dataset.rotAbs || el.dataset.rot || 0}deg)`;

      const color = f.color || FURN_COLORS[t] || null;
      if (color) applyFurnitureColor(el, t, color);

      const label = document.createElement('div'); label.className = 'label'; label.textContent = f.label || f.type || 'meuble';
      const makeHandle = (dir) => { const h = document.createElement('div'); h.className = `rz ${dir}`; h.dataset.dir = dir; h.title = 'Redimensionner'; h.addEventListener('pointerdown', startResizeFurniture); return h; };
      el.append(label, makeHandle('nw'), makeHandle('ne'), makeHandle('se'), makeHandle('sw'));
      addDeleteButton(el); addFurnRotate(el);
      el.addEventListener('pointerdown', startDragFurniture);
      $stage.appendChild(el);
    }
  }

  function render() {
    renderPlansSelect();
    clearStage();
    fitStageToWrap();

    const posById = {}; for (const p of state.positions) posById[p.eleve_id] = p;
    for (const e of state.eleves) { const pos = posById[e.id]; if (pos) addCard(e, pos); }
    renderEleveList();
    renderFurniture();
    ensureFurniturePalette();
  }

  // ===== palette meubles =====
  const FURN_DEFS = [
    { type: 'desk', label: 'Bureau', w: 2, h: 1 },
    { type: 'table_rect', label: 'Table', w: 2, h: 1 },
    { type: 'table_round', label: 'Table ronde', w: 2, h: 2 },
    { type: 'armoire', label: 'Armoire', w: 1, h: 2 },
    { type: 'board', label: 'Tableau', w: 4, h: 1 },
    { type: 'door', label: 'Porte', w: 1, h: 1 },
    { type: 'window', label: 'Fenêtre', w: 2, h: 1 },
    { type: 'sink', label: 'Évier', w: 2, h: 1 },
    { type: 'trash', label: 'Poubelle', w: 1, h: 1 },
    { type: 'plant', label: 'Plante', w: 1, h: 1 },
  ];

  function ensureFurniturePalette() {
    if (!$palette) return;
    if ($palette.dataset.built === '1') return;
    $palette.innerHTML = '';

    FURN_DEFS.forEach(d => {
      const item = document.createElement('div');
      item.className = 'pc_furn_tpl';
      const color = FURN_COLORS[d.type] || FURN_DEF_COLORS[d.type] || '#ffffff';
      item.innerHTML = `
        <div class="thumb ${d.type === 'table_round' ? 'round' : ''}" style="background:${color};border-color:${color}"></div>
        <div class="info">
          <div class="name">${d.label}</div>
          <div class="dims">${d.w}×${d.h}</div>
        </div>
        <input class="colpick" type="color" value="${color}" title="Couleur ${d.label}" />
      `;

      // ⛔️ plus d’ajout au clic — uniquement drag pour créer
      item.addEventListener('pointerdown', (ev) => startCreateFurnitureDrag(ev, d));

      // color picker → MAJ modèles + meubles de ce type
      const cp = item.querySelector('.colpick');
      cp.addEventListener('input', () => {
        FURN_COLORS[d.type] = cp.value;
        const thumb = item.querySelector('.thumb');
        if (thumb) { thumb.style.background = cp.value; thumb.style.borderColor = cp.value; }
        state.furniture.forEach(f => { if (f.type === d.type) f.color = cp.value; });
        autosaveFurniture();
        $stage.querySelectorAll(`.pc_furn.type-${d.type}`).forEach(el => applyFurnitureColor(el, d.type, cp.value));
      });

      $palette.appendChild(item);
    });

    $palette.dataset.built = '1';
  }

  // ===== Drag créer meuble (fantôme) — drag & drop uniquement + seuil
  let dragGhost = null;

  function startCreateFurnitureDrag(ev, def) {
    ev.preventDefault();
    let hasDrag = false;
    const sx = ev.clientX, sy = ev.clientY;

    const ensureGhost = () => {
      if (dragGhost) return;
      dragGhost = document.createElement('div');
      dragGhost.style.position = 'fixed';
      dragGhost.style.pointerEvents = 'none';
      dragGhost.style.zIndex = '9999';
      dragGhost.style.opacity = '0.7';
      dragGhost.style.width = `${toPx(def.w)}px`;
      dragGhost.style.height = `${toPx(def.h)}px`;
      const c = FURN_COLORS[def.type] || FURN_DEF_COLORS[def.type] || '#fff';
      dragGhost.style.background = c; dragGhost.style.border = `1px dashed ${darken(c, .22)}`;
      document.body.appendChild(dragGhost);
    };

    const onMove = (e) => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!hasDrag && Math.hypot(dx, dy) > DRAG_THRESHOLD) { hasDrag = true; ensureGhost(); }
      if (hasDrag && dragGhost) { dragGhost.style.left = (e.clientX + 6) + 'px'; dragGhost.style.top = (e.clientY + 6) + 'px'; }
    };

    const onUp = (e) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp, { once: true });
      if (dragGhost) { dragGhost.remove(); dragGhost = null; }
      if (!hasDrag) return;                 // clic simple → ne rien faire
      if (!isPointInStage(e.clientX, e.clientY)) return; // drop hors scène → ignore

      const rotAbs = 0; // nouveaux à 0°
      const swap = isQuarterTurnSwap(rotAbs);
      const wEff = swap ? def.h : def.w;
      const hEff = swap ? def.w : def.h;

      const { x: gx, y: gy } = clientToUnitsClamped(e.clientX, e.clientY, wEff, hEff);
      let spot = findNearestFreeSpot(gx, gy, wEff, hEff) || { x: gx, y: gy };
      spot = snapCollapse(spot, rectsInPlan({}));

      const col = FURN_COLORS[def.type] || FURN_DEF_COLORS[def.type] || '#fff';
      state.furniture.push({
        id: tempIdSeq--,
        uid: genUid(),
        type: def.type, label: def.label, color: col,
        x: spot.x, y: spot.y,
        w: def.w, h: def.h,
        rotation: 0, rotAbs: 0, z: 0
      });
      autosaveFurniture(); render();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }
  function moveGhost(e) { if (!dragGhost) return; dragGhost.style.left = (e.clientX + 6) + 'px'; dragGhost.style.top = (e.clientY + 6) + 'px'; }

  // ===== Drag depuis la liste (élève) — drag & drop uniquement + seuil
  let dragData = null;

  function startDragFromList(ev) {
    ev.preventDefault();
    const eleveId = parseInt(ev.currentTarget.dataset.eleveId, 10);
    dragData = { kind: 'fromList', eleveId };

    let hasDrag = false;
    const sx = ev.clientX, sy = ev.clientY;
    let ghost = null;

    const ensureGhost = () => {
      if (ghost) return;
      const g = ev.currentTarget.cloneNode(true);
      g.style.position = 'fixed'; g.style.pointerEvents = 'none'; g.style.opacity = '0.7'; g.style.zIndex = '9999';
      g.style.width = ev.currentTarget.offsetWidth + 'px';
      document.body.appendChild(g); dragGhost = g; ghost = g;
    };

    const onMove = (e) => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!hasDrag && Math.hypot(dx, dy) > DRAG_THRESHOLD) { hasDrag = true; ensureGhost(); }
      if (hasDrag && dragGhost) { dragGhost.style.left = (e.clientX + 5) + 'px'; dragGhost.style.top = (e.clientY + 5) + 'px'; }
    };

    const onUp = (e) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp, { once: true });
      if (dragGhost) { dragGhost.remove(); dragGhost = null; }
      if (!hasDrag) { dragData = null; return; }
      if (!isPointInStage(e.clientX, e.clientY)) { dragData = null; return; }

      const fp = footprintCardUnits();
      const { x: gx, y: gy } = clientToUnitsClamped(e.clientX, e.clientY, fp.w, fp.h);
      let spot = findNearestFreeSpot(gx, gy, fp.w, fp.h, {}) || { x: gx, y: gy };
      spot = snapCollapse(spot, rectsInPlan({}));

      state.positions.push({ eleve_id: dragData.eleveId, x: spot.x, y: spot.y, seat_id: null, rot: 0, rotAbs: 0 });
      autosavePositions(); dragData = null; render();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  // ===== Drag carte élève (déplacement) =====
  function startDragCard(ev) {
    if (ev.target.closest('.pc_delete_btn')) return;
    ev.preventDefault();
    const card = ev.currentTarget;
    dragData = {
      kind: 'card', eleveId: parseInt(card.dataset.eleveId, 10),
      startLeft: parseFloat(card.style.left || '0'), startTop: parseFloat(card.style.top || '0'),
      sx: ev.clientX, sy: ev.clientY
    };
    card.setPointerCapture(ev.pointerId);
    card.addEventListener('pointermove', onDragCardMove);
    card.addEventListener('pointerup', endDragCard, { once: true });
  }
  function onDragCardMove(ev) {
    const card = ev.currentTarget;
    card.style.left = (dragData.startLeft + (ev.clientX - dragData.sx)) + 'px';
    card.style.top = (dragData.startTop + (ev.clientY - dragData.sy)) + 'px';
  }
  function endDragCard(ev) {
    const card = ev.currentTarget;
    card.releasePointerCapture(ev.pointerId);
    card.removeEventListener('pointermove', onDragCardMove);

    const lx = parseFloat(card.style.left || '0');
    const ly = parseFloat(card.style.top || '0');
    const fp = footprintCardUnits();

    const box = stageInnerBox();
    const gxgy = clientToUnitsClamped(box.left + lx, box.top + ly, fp.w, fp.h);

    let spot = findNearestFreeSpot(gxgy.x, gxgy.y, fp.w, fp.h, { eleveId: dragData.eleveId });
    if (spot) {
      spot = snapCollapse(spot, rectsInPlan({ eleveId: dragData.eleveId }));
      const p = state.positions.find(p => p.eleve_id === dragData.eleveId);
      if (p) { p.x = spot.x; p.y = spot.y; } else { state.positions.push({ eleve_id: dragData.eleveId, x: spot.x, y: spot.y, seat_id: null, rot: 0, rotAbs: 0 }); }
      autosavePositions();
    } else {
      shake(card);
    }

    dragData = null; render();
  }

  // ===== Meubles : drag + resize 4 coins + rotation (empreinte tournée) =====
  function startDragFurniture(ev) {
    if (ev.target.closest('.pc_delete_btn')) return;
    if (ev.target.classList.contains('rz')) return;
    const el = ev.currentTarget;
    dragData = {
      kind: 'furn', id: el.dataset.id ? parseInt(el.dataset.id, 10) : null,
      startLeft: parseFloat(el.style.left || '0'), startTop: parseFloat(el.style.top || '0'),
      sx: ev.clientX, sy: ev.clientY
    };
    el.setPointerCapture(ev.pointerId);
    el.addEventListener('pointermove', onDragFurnitureMove);
    el.addEventListener('pointerup', endDragFurniture, { once: true });
  }
  function onDragFurnitureMove(ev) {
    const el = ev.currentTarget;
    el.style.left = (dragData.startLeft + (ev.clientX - dragData.sx)) + 'px';
    el.style.top = (dragData.startTop + (ev.clientY - dragData.sy)) + 'px';
  }
  function endDragFurniture(ev) {
    const el = ev.currentTarget;
    el.releasePointerCapture(ev.pointerId);
    el.removeEventListener('pointermove', onDragFurnitureMove);

    const L = parseFloat(el.style.left || '0');
    const T = parseFloat(el.style.top || '0');
    const W = parseFloat(el.style.width || '0');
    const H = parseFloat(el.style.height || '0');

    // tailles “de base” stockées (sans rotation)
    const gw = Math.max(TICK, Math.ceil((W / unitPx) * UI_SUBDIV) / UI_SUBDIV);
    const gh = Math.max(TICK, Math.ceil((H / unitPx) * UI_SUBDIV) / UI_SUBDIV);

    const rotNow = parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0;
    const swapNow = isQuarterTurnSwap(rotNow);
    const wEff = swapNow ? gh : gw;
    const hEff = swapNow ? gw : gh;

    const box = stageInnerBox();
    const { x: gx, y: gy } = clientToUnitsClamped(box.left + L, box.top + T, wEff, hEff);

    const id = (dragData && dragData.id != null) ? dragData.id : null;
    const fRef = (id != null) ? state.furniture.find(x => x.id === id) : null;

    let spot = findNearestFreeSpot(gx, gy, wEff, hEff, { furnitureId: id ?? -1 });
    if (!spot) { shake(el); dragData = null; render(); return; }
    spot = snapCollapse(spot, rectsInPlan({ furnitureId: id ?? -1 }));

    if (fRef) {
      fRef.x = spot.x; fRef.y = spot.y;
    } else {
      const type = el.dataset.furnitureType || 'autre';
      const label = el.querySelector('.label')?.textContent || type;
      const color = FURN_COLORS[type] || FURN_DEF_COLORS[type] || null;
      state.furniture.push({
        id: tempIdSeq--,
        uid: genUid(),
        type, label, color,
        x: spot.x, y: spot.y,
        w: gw, h: gh,
        rotation: rotNow % 360,
        rotAbs: rotNow % 360,
        z: 0
      });
    }

    autosaveFurniture();
    dragData = null;
    render();
  }

  function startResizeFurniture(ev) {
    const el = ev.currentTarget.parentElement;
    const dir = ev.currentTarget.dataset.dir; // nw / ne / se / sw
    const startLeft = parseFloat(el.style.left || '0'), startTop = parseFloat(el.style.top || '0');
    const startW = parseFloat(el.style.width || '0'), startH = parseFloat(el.style.height || '0');
    dragData = { kind: 'resize', id: el.dataset.id ? parseInt(el.dataset.id, 10) : null, dir, startLeft, startTop, startW, startH, sx: ev.clientX, sy: ev.clientY };
    el.setPointerCapture(ev.pointerId);
    el.addEventListener('pointermove', onResizeFurnitureMove);
    el.addEventListener('pointerup', endResizeFurniture, { once: true });
    ev.stopPropagation();
  }
  function onResizeFurnitureMove(ev) {
    const el = ev.currentTarget;
    const dx = (ev.clientX - dragData.sx), dy = (ev.clientY - dragData.sy);
    let L = dragData.startLeft, T = dragData.startTop, W = dragData.startW, H = dragData.startH;

    if (dragData.dir.includes('w')) { L = dragData.startLeft + dx; W = dragData.startW - dx; }
    if (dragData.dir.includes('e')) { W = dragData.startW + dx; }
    if (dragData.dir.includes('n')) { T = dragData.startTop + dy; H = dragData.startH - dy; }
    if (dragData.dir.includes('s')) { H = dragData.startH + dy; }

    W = Math.max(16, W); H = Math.max(16, H);
    el.style.left = `${L}px`; el.style.top = `${T}px`; el.style.width = `${W}px`; el.style.height = `${H}px`;
  }
  function endResizeFurniture(ev) {
    const el = ev.currentTarget;
    el.releasePointerCapture(ev.pointerId);
    el.removeEventListener('pointermove', onResizeFurnitureMove);

    const L = parseFloat(el.style.left || '0');
    const T = parseFloat(el.style.top || '0');
    const W = parseFloat(el.style.width || '0');
    const H = parseFloat(el.style.height || '0');

    const gw = Math.max(TICK, Math.ceil((W / unitPx) * UI_SUBDIV) / UI_SUBDIV);
    const gh = Math.max(TICK, Math.ceil((H / unitPx) * UI_SUBDIV) / UI_SUBDIV);

    const rotNow = parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0;
    const swapNow = isQuarterTurnSwap(rotNow);
    const wEff = swapNow ? gh : gw;
    const hEff = swapNow ? gw : gh;

    const box = stageInnerBox();
    const { x: gx, y: gy } = clientToUnitsClamped(box.left + L, box.top + T, wEff, hEff);

    const id = (dragData && dragData.id != null) ? dragData.id : null;
    let spot = findNearestFreeSpot(gx, gy, wEff, hEff, { furnitureId: id ?? -1 });
    if (!spot) { shake(el); dragData = null; render(); return; }
    spot = snapCollapse(spot, rectsInPlan({ furnitureId: id ?? -1 }));

    const f = (id != null) ? state.furniture.find(x => x.id === id) : null;
    if (f) {
      f.w = gw; f.h = gh; f.x = spot.x; f.y = spot.y;
    } else {
      const type = el.dataset.furnitureType || 'autre';
      const label = el.querySelector('.label')?.textContent || type;
      const color = FURN_COLORS[type] || FURN_DEF_COLORS[type] || null;
      state.furniture.push({
        id: tempIdSeq--,
        uid: genUid(),
        type, label, color,
        x: spot.x, y: spot.y,
        w: gw, h: gh,
        rotation: rotNow % 360,
        rotAbs: rotNow % 360,
        z: 0
      });
    }

    autosaveFurniture();
    dragData = null;
    render();
  }

  // ===== suppression =====
  function addDeleteButton(el) {
    const btn = document.createElement('div');
    btn.className = 'pc_delete_btn'; btn.textContent = '×'; btn.title = 'Supprimer';
    btn.addEventListener('click', (e) => { e.stopPropagation(); removeElement(el); });
    el.appendChild(btn);
  }
  function removeElement(el) {
    const typ = el.dataset.type; if (!state.active_plan) return;
    if (typ === 'eleve') {
      const eleveId = parseInt(el.dataset.id, 10);
      api.deletePosition(state.active_plan.id, eleveId).then(() => {
        state.positions = state.positions.filter(p => p.eleve_id !== eleveId);
        el.remove();
        const e = state.eleves.find(x => x.id === eleveId);
        if (e && $elist) {
          const item = document.createElement('div'); item.className = 'pc_eleve_item'; item.dataset.eleveId = e.id;
          const img = document.createElement('img'); img.src = PHOTOS_BASE + (e.photo_filename || 'default.jpg');
          const name = document.createElement('div'); name.className = 'name'; name.textContent = `${e.prenom} ${e.nom}`;
          item.append(img, name); item.addEventListener('pointerdown', startDragFromList);
          $elist.appendChild(item);
        }
      }).catch(err => { console.error(err); alert("Suppression impossible (élève)."); });
    }
    if (typ === 'furniture') {
      const fid = parseInt(el.dataset.id, 10);
      if (!fid || fid < 0) {
        const f = state.furniture.find(x => x.id === fid);
        if (f?.uid) sentNewFurniture.delete(f.uid);
        state.furniture = state.furniture.filter(f => f.id !== fid);
        el.remove();
        return;
      }
      api.deleteFurniture(state.active_plan.id, fid).then(() => {
        state.furniture = state.furniture.filter(f => f.id !== fid); el.remove();
      }).catch(err => { console.error(err); alert("Suppression impossible (meuble)."); });
    }
  }

  // ===== Toolbar =====
  $sel?.addEventListener('change', () => {
    const id = parseInt($sel.value, 10);
    state.active_plan = state.plans.find(p => p.id === id) || state.active_plan;
    PLAN_SUBDIV = 32; UI_SUBDIV = 32;
    render();
  });

  $new?.addEventListener('click', async () => {
    const name = prompt("Nom du plan :", "Rentrée"); if (!name) return;
    const r = await api.create({ classe_id: classeId, name, width: 30, height: 20, grid_size: unitPx });
    await boot();
    if (r.plan_id) { $sel.value = String(r.plan_id); $sel.dispatchEvent(new Event('change')); }
  });
  $dup?.addEventListener('click', async () => { if (!state.active_plan) return; await api.duplicate(state.active_plan.id); await boot(); });
  $act?.addEventListener('click', async () => { if (!state.active_plan) return; await api.activate(state.active_plan.id); await boot(); });
  $pdf?.addEventListener('click', () => { if (!state.active_plan) return; window.open(`${API_BASE}/plans/${state.active_plan.id}/export/pdf`, '_blank'); });
  $reset?.addEventListener('click', async (ev) => {
    if (!state.active_plan) return;
    const hard = !!ev.shiftKey; const label = hard ? "TOUT (élèves + meubles + tables)" : "élèves + meubles";
    if (!confirm(`Réinitialiser le plan actif (${label}) ?`)) return;
    try { await api.reset(state.active_plan.id, hard); await boot(); } catch (e) { console.error(e); alert("Reset impossible."); }
  });
  $full?.addEventListener('click', () => { const el = $wrap; if (!document.fullscreenElement) el.requestFullscreen?.(); else document.exitFullscreen?.(); });

  // ===== Boot =====
  function fromDBPosition(p) {
    const rot = Number(p.rot || 0);
    return { ...p, x: (+p.x || 0) / PLAN_SUBDIV, y: (+p.y || 0) / PLAN_SUBDIV, rot, rotAbs: rot };
  }
  function fromDBFurniture(f) {
    const rot = Number(f.rotation || 0);
    return {
      ...f,
      x: (+f.x || 0) / PLAN_SUBDIV, y: (+f.y || 0) / PLAN_SUBDIV, w: (+f.w || 1) / PLAN_SUBDIV, h: (+f.h || 1) / PLAN_SUBDIV,
      rotation: rot, rotAbs: rot, color: f.color || null
    };
  }
  function pickActivePlan(plans, currentActive, apiActive) {
    if (apiActive) return apiActive;
    if (currentActive) { const keep = plans.find(p => p.id === currentActive.id); if (keep) return keep; }
    return plans[0] || null;
  }

  async function boot() {
    try {
      document.body.classList.add('pc_loading');
      const data = await api.getAll();
      const plans = Array.isArray(data.plans) ? data.plans : [];
      const eleves = Array.isArray(data.eleves) ? data.eleves : [];
      const active_plan = pickActivePlan(plans, state.active_plan, data.active_plan);

      state.active_plan = active_plan;
      PLAN_SUBDIV = 32; UI_SUBDIV = 32;

      const positions = Array.isArray(data.positions) ? data.positions.map(fromDBPosition) : [];
      const furniture = Array.isArray(data.furniture) ? data.furniture.map(fromDBFurniture) : [];
      const seats = Array.isArray(data.seats) ? data.seats : [];

      state = { ...state, plans, active_plan, eleves, positions, furniture, seats };
      sentNewFurniture.clear(); // très important : on repart propre
      render();
    } catch (err) {
      console.error('[boot] load fail', err);
      alert("Impossible de charger les plans de classe pour le moment.");
    } finally {
      document.body.classList.remove('pc_loading');
    }
  }

  window.addEventListener('resize', () => { render(); });

  boot().catch(console.error);
})();
