
(() => {
  // [0] ----------------------------------------------------------------------
  // Bootstrap & Constants
  // -------------------------------------------------------------------------

  const $stage = document.getElementById('pc_stage');
  if (!$stage) return;
  let _justPastedAt = 0;
  const JUST_PASTED_GRACE_MS = 250; // petit délai de grâce

  const conf = window.SEATING_CONF || {};
  const classeId = conf.classeId || parseInt($stage.dataset.classeId, 10);
  const API_BASE = (conf.apiBase || "/seating") + "/api";
  const PHOTOS_BASE = conf.photosBase || "/static/photos/";

  let UI_SUBDIV = 32;    // précision UI (ticks aimantation)
  let PLAN_SUBDIV = 32;  // précision stockage API
  let unitPx = 32;       // dimension d'une unité en pixels (calculée par autofit)

  // ids temporaires (meubles) & mode édition
  let tempIdSeq = -1;
  let editMode = false;

  // ---- Échelle réelle pour les élèves
  const CM_PER_UNIT = 25;  // 1 unité = 25 cm
  const STUDENT_W_CM = 70;
  const STUDENT_H_CM = 50;
  const cmToUnits = (cm) => cm / CM_PER_UNIT;



  // Rayon "coins arrondis" en unités du plan (1 u = 25 cm)
  // 12px à l’échelle par défaut (~32 px/u) ≈ 0.375 u ≈ 9.4 cm
  const CORNER_R_UNITS = 0.375;

  const cornerUnitsFor = (f) => (f?.radius ? CORNER_R_UNITS : 0);
  const cornerPxFor = (f) => Math.round(cornerUnitsFor(f) * unitPx);

  function applyCornerRadiusPx(el, f) {
    const rpx = cornerPxFor(f);
    el.style.borderRadius = rpx ? `${rpx}px` : '0';
  }

  // évite les resync pendant un drag et permet de restaurer la sélection après boot()
  let isDraggingNow = false;
  let pendingSelSnap = null;

  // anti-duplications autosave (nouveaux meubles)
  const sentNewFurniture = new Set(); // uid client déjà envoyé durant un debounce

  // état global unifié
  let state = {
    plans: [],
    active_plan: null,
    furniture: [],
    positions: [],
    walls: [],     // [{ id, points:[{x,y}...] }] en UNITÉS
    seats: [],
    eleves: []
  };

  // Conversion centimètres -> pixels
  function cmToPx(cm) {
    // si tu as déjà unitPx défini globalement :
    if (typeof unitPx !== "undefined") {
      return (cm / CM_PER_UNIT) * unitPx;
    }
    // sinon, fallback approximatif : 10 px = 1 cm
    return cm * 10;
  }

  // couleurs par type — défauts (palette) pour futurs meubles
  const FURN_DEF_COLORS = {
    desk: "#f1e7db", table_rect: "#fffef7", table_round: "#fffef7",
    armoire: "#d7c5ad", board: "#0f5132", door: "#b87333",
    window: "#cfe8ff", sink: "#e5e7eb", trash: "#475569", plant: "#def7ec"
  };
  const FURN_COLORS = { ...FURN_DEF_COLORS };

  // DOM utiles
  const $sel = document.getElementById('pc_plan_select');
  const $new = document.getElementById('pc_new_plan');
  const $dup = document.getElementById('pc_duplicate');
  const $act = document.getElementById('pc_activate');
  const $pdf = document.getElementById('pc_export_pdf');

  const $elist = document.getElementById('pc_eleve_list');
  const $wrap = $stage.parentElement;
  const $reset = document.getElementById('pc_reset_plan');
  const $palette = document.getElementById('pc_furn_palette');
  const $edit = document.getElementById('pc_edit_mode');
  const $delPlan = document.getElementById('pc_delete_plan');

  // conteneur SVG (murs)
  let $svg = document.getElementById('pc_svg') || null;

  // --- Marquee (sélection rectangulaire)
  let marqueeEl = null;
  let marqueeData = null; // { sx, sy, add, box }
  let pendingShiftDeselect = null; // node à désélectionner si clic sans drag

  // [1] ----------------------------------------------------------------------
  // Utils (unités/px, géométrie, couleurs, localStorage)
  // -------------------------------------------------------------------------

  const EPS = 1e-6;
  const TICK = 1 / UI_SUBDIV;
  const DRAG_THRESHOLD = 2; // px

  const toPx = u => u * unitPx;

  const snapUnits = v => Math.round(v * UI_SUBDIV) / UI_SUBDIV;
  const snapUnitsDir = (v, dir) => {
    const s = v * UI_SUBDIV;
    if (dir > 0) return Math.ceil(s) / UI_SUBDIV;
    if (dir < 0) return Math.floor(s) / UI_SUBDIV;
    return Math.round(s) / UI_SUBDIV;
  };
  const norm360 = a => ((a % 360) + 360) % 360;
  const round1 = x => Math.round((+x || 0) * 10) / 10; // garde 1 décimale
  // --- Normalise un meuble reçu du serveur à 0,1° et alimente rotation/rotAbs
  function normalizeFurnitureArray(arr) {
    return (arr || []).map(f => {
      const rot = round1(norm360(parseFloat(f.rotation ?? f.rotAbs ?? f.rot ?? 0)));
      return { ...f, rotation: rot, rotAbs: rot };
    });
  }

  const genUid = () => 'f_' + Math.random().toString(36).slice(2, 10);

  // localStorage: rotations élève par plan/élève
  const posRotKey = pid => `pc_posrot_${pid}`;
  const lsGetPosRots = pid => { try { return JSON.parse(localStorage.getItem(posRotKey(pid)) || '{}'); } catch { return {}; } };
  const lsSetPosRot = (pid, eleveId, rot) => { try { const m = lsGetPosRots(pid); m[eleveId] = rot; localStorage.setItem(posRotKey(pid), JSON.stringify(m)); } catch { } };

  // localStorage: couleur par plan+meuble
  const colorKey = (pid, id) => `pc_color_${pid}_${id}`;
  const lsGetColor = (pid, id) => { try { return localStorage.getItem(colorKey(pid, id)); } catch { return null; } };
  const lsSetColor = (pid, id, val) => { try { localStorage.setItem(colorKey(pid, id), val); } catch { } };
  const lsDelColor = (pid, id) => { try { localStorage.removeItem(colorKey(pid, id)); } catch { } };

  // walls: encode <-> decode en base PLAN_SUBDIV (stockage en entiers)
  function encodeWallsForStorage(walls) {
    return (walls || []).map(w => ({
      id: w.id || genUid(),
      points: (w.points || []).map(p => ({
        x: Math.round((+p.x || 0) * PLAN_SUBDIV),
        y: Math.round((+p.y || 0) * PLAN_SUBDIV),
      }))
    }));
  }
  function decodeWallsFromStorage(stored) {
    return (stored || []).map(w => ({
      id: w.id || genUid(),
      points: (w.points || []).map(p => ({
        x: (+p.x || 0) / PLAN_SUBDIV,
        y: (+p.y || 0) / PLAN_SUBDIV,
      }))
    }));
  }

  // stage box
  function stageInnerBox() {
    const r = $stage.getBoundingClientRect();
    const cs = getComputedStyle($stage);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    const left = r.left + bl, top = r.top + bt;
    return { left, top, width: r.width - bl - br, height: r.height - bt - bb };
  }
  function isPointInStage(clientX, clientY) {
    const b = stageInnerBox();
    return clientX >= b.left && clientX <= (b.left + b.width) &&
      clientY >= b.top && clientY <= (b.top + b.height);
  }

  const normDeg = a => { let d = a % 360; if (d < 0) d += 360; return d; };
  const isQuarterTurnSwap = deg => (Math.round(normDeg(deg) / 90) % 4) % 2 === 1;

  function updateAlignBarVisibility() {
    const bar = document.getElementById('pc_align_bar');
    if (!bar) return;
    // 'selection' est ton Set global des éléments sélectionnés
    const count = (typeof selection?.size === 'number') ? selection.size : 0;
    bar.hidden = !(count >= 2);
  }

  // Intercepte add/delete/clear sur le Set 'selection' pour MAJ auto
  function bindSelectionBarHooks() {
    if (!window.selection || typeof selection.add !== 'function') return;
    const origAdd = selection.add.bind(selection);
    const origDel = selection.delete.bind(selection);
    const origClr = selection.clear ? selection.clear.bind(selection) : null;

    selection.add = (v) => { const r = origAdd(v); updateAlignBarVisibility(); return r; };
    selection.delete = (v) => { const r = origDel(v); updateAlignBarVisibility(); return r; };
    if (origClr) {
      selection.clear = () => { const r = origClr(); updateAlignBarVisibility(); return r; };
    }

    // Premier affichage
    updateAlignBarVisibility();
  }

  // empreinte élève (en unités), aimantée aux ticks
  function studentFootprintUnits() {
    const w = Math.max(TICK, Math.round(cmToUnits(STUDENT_W_CM) * UI_SUBDIV) / UI_SUBDIV);
    const h = Math.max(TICK, Math.round(cmToUnits(STUDENT_H_CM) * UI_SUBDIV) / UI_SUBDIV);
    return { w, h };
  }
  // Alias global pour compat
  const footprintCardUnits = studentFootprintUnits;

  // helpers sélection
  const selection = new Set();
  window.selection = selection;
  function selectionSnapshot() {
    return Array.from(selection).map(n => {
      if (n.classList.contains('pc_card')) return { kind: 'card', id: n.dataset.eleveId };
      if (n.classList.contains('pc_furn')) return { kind: 'furn', id: n.dataset.id };
      if (n.tagName === 'polyline' && n.classList.contains('wall')) return { kind: 'wall', id: n.dataset.wallId };
      return null;
    }).filter(Boolean);
  }
  function restoreSelectionFromSnapshot(snap) {
    selection.clear();
    snap.forEach(s => {
      let node = null;
      if (s.kind === 'card') node = $stage.querySelector(`.pc_card[data-eleve-id="${s.id}"]`);
      else if (s.kind === 'furn') node = $stage.querySelector(`.pc_furn[data-id="${s.id}"]`);
      else if (s.kind === 'wall') node = $svg?.querySelector(`.wall[data-wall-id="${s.id}"]`);
      if (node) selection.add(node);
    });
    refreshSelectionStyling();
  }

  function selectNodeOnPointerDown(node, e) {
    const already = selection.has(node);
    pendingShiftDeselect = null;

    if (e.shiftKey) {
      if (already) {
        // ⛔️ ne pas toggler tout de suite (autorise drag groupé)
        pendingShiftDeselect = node;
      } else {
        selection.add(node);
      }
    } else {
      // Toujours mono-sélection sur clic simple
      selection.clear();
      selection.add(node);
    }
    // Mémorise le dernier meuble cliqué pour Ctrl+C
    if (node.classList.contains('pc_furn')) {
      window._lastClickedFurn = node;
      // Empêche une sélection mixte (cartes + meubles)
      limitSelectionToKind(node);
    }
    refreshSelectionStyling();


    // Positions de départ pour le drag groupé
    selection.forEach(n => {
      n.dataset._startL = n.style.left;
      n.dataset._startT = n.style.top;
    });
  }

  function limitSelectionToKind(node) {
    const keepCard = node.classList.contains('pc_card');
    const keepFurn = node.classList.contains('pc_furn');
    if (!keepCard && !keepFurn) return;
    selection.forEach(n => {
      if (keepCard && !n.classList.contains('pc_card')) selection.delete(n);
      if (keepFurn && !n.classList.contains('pc_furn')) selection.delete(n);
    });
  }


  function clearSelection() {
    selection.clear();
    refreshSelectionStyling?.();
  }
  function selectNode(node, add = false) {
    if (!add) selection.clear();
    selection.add(node);
    refreshSelectionStyling?.();
  }
  // dispo global au cas où du code les appelle
  window.clearSelection = clearSelection;
  window.selectNode = selectNode;

  // couleurs
  function hexToRgb(hex) {
    const x = hex.replace('#', '');
    const n = parseInt(x.length === 3 ? x.split('').map(c => c + c).join('') : x, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function darken(hex, pct = .22) {
    const { r, g, b } = hexToRgb(hex);
    const d = c => Math.max(0, Math.round(c * (1 - pct)));
    const h = n => n.toString(16).padStart(2, '0');
    return `#${h(d(r))}${h(d(g))}${h(d(b))}`;
  }

  // ↔︎ format longueur (en m/cm) à partir d'unités plan
  function formatLen(units) {
    const cm = units * CM_PER_UNIT;
    if (cm >= 100) return `${(cm / 100).toFixed(2).replace('.', ',')} m (${Math.round(cm)} cm)`;
    return `${Math.round(cm)} cm`;
  }

  // --- Helpers pour POST/PUT/DELETE avec cookie + CSRF ----------------------
  function getCsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    const meta = document.querySelector('meta[name="csrf-token"], meta[name="csrfmiddlewaretoken"]');
    return meta?.getAttribute('content') || '';
  }

  async function fetchWithCsrf(url, opts = {}) {
    const headers = new Headers(opts.headers || {});
    const method = (opts.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const token = getCsrfToken();
      if (token && !headers.has('X-CSRFToken')) headers.set('X-CSRFToken', token);
    }
    return fetch(url, { credentials: 'same-origin', ...opts, headers });
  }

  // Retourne {} si 204/no JSON, sinon parse le JSON. Lance erreur si !ok
  const jsonIfAny = async (r) => {
    if (!r.ok) {
      let msg = '';
      try { msg = await r.text(); } catch { }
      throw new Error(`HTTP ${r.status} ${r.statusText}${msg ? ' – ' + msg.slice(0, 200) : ''}`);
    }
    if (r.status === 204) return {};
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return {};
    const txt = await r.text();
    return txt ? JSON.parse(txt) : {};
  };

  // Place le libellé au milieu du segment, toujours lisible (jamais à l'envers)
  function computeWallLabelPlacement(dx, dy, midxU, midyU) {
    // angle "lisible" en degrés
    let angDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    let offSign = 1;
    if (angDeg > 90) { angDeg -= 180; offSign = -1; }
    else if (angDeg < -90) { angDeg += 180; offSign = -1; }

    const angRad = angDeg * Math.PI / 180;
    const off = Math.max(8, unitPx * 0.35); // décalage perpendiculaire
    const xpx = toPx(midxU) + Math.cos(angRad + Math.PI / 2) * off * offSign;
    const ypx = toPx(midyU) + Math.sin(angRad + Math.PI / 2) * off * offSign;

    return { xpx, ypx, angDeg };
  }

  function cleanupOrphanMeasures() {
    if (!$svg) return;
    const alive = new Set((state.walls || []).map(w => String(w.id)));
    $svg.querySelectorAll('.wall-measure, .wall-angle').forEach(t => {
      if (!alive.has(String(t.dataset.wallId))) t.remove();
    });
  }

  function computeAngleDeg(a, b, c) {
    // angle intérieur entre BA et BC en degrés
    const v1x = a.x - b.x, v1y = a.y - b.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y);
    if (n1 < EPS || n2 < EPS) return null;
    let cos = (v1x * v2x + v1y * v2y) / (n1 * n2);
    cos = Math.max(-1, Math.min(1, cos));
    return Math.round(Math.acos(cos) * 180 / Math.PI); // 0..180
  }

  function buildWallAnglesFor(w) {
    if (!$svg || !w.points || w.points.length < 3) return;
    for (let i = 1; i < w.points.length - 1; i++) {
      const a = w.points[i - 1], b = w.points[i], c = w.points[i + 1];
      const ang = computeAngleDeg(a, b, c);
      if (ang == null) continue;

      // direction du bissecteur
      let u1x = a.x - b.x, u1y = a.y - b.y;
      let u2x = c.x - b.x, u2y = c.y - b.y;
      const n1 = Math.hypot(u1x, u1y) || 1, n2 = Math.hypot(u2x, u2y) || 1;
      u1x /= n1; u1y /= n1; u2x /= n2; u2y /= n2;
      let bx = u1x + u2x, by = u1y + u2y;
      let bl = Math.hypot(bx, by);
      if (bl < 1e-6) { bx = -u2y; by = u2x; bl = 1; }
      bx /= bl; by /= bl;

      const rPx = Math.max(12, unitPx * 0.6);
      const xpx = toPx(b.x + (bx * (rPx / unitPx)));
      const ypx = toPx(b.y + (by * (rPx / unitPx)));

      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('class', 'wall-angle');
      t.dataset.wallId = String(w.id);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      t.style.pointerEvents = 'none';
      t.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      t.style.fontSize = `${Math.max(11, unitPx * 0.45)}px`;
      t.style.fontWeight = '700';
      t.style.paintOrder = 'stroke';
      t.style.stroke = '#ffffff';
      t.style.strokeWidth = '3';
      t.style.strokeLinejoin = 'round';
      t.style.fill = '#111827';
      t.textContent = `${ang}°`;
      t.setAttribute('x', String(xpx));
      t.setAttribute('y', String(ypx));
      $svg.appendChild(t);
    }
  }

  function hideWallAngles(wallId) {
    $svg?.querySelectorAll(`.wall-angle[data-wall-id="${wallId}"]`).forEach(n => n.remove());
  }

  function updateVisibleWallAngles() {
    if (!$svg) return;
    const ids = [...new Set(Array.from($svg.querySelectorAll('.wall-angle')).map(n => n.dataset.wallId))];
    ids.forEach(id => {
      hideWallAngles(id);
      const w = state.walls.find(W => String(W.id) === String(id));
      if (w) buildWallAnglesFor(w);
    });
  }
  // — flèche diagonale la plus proche d'un angle (↖ ↗ ↘ ↙)
  function diagArrowFor(deg) {
    const a = ((deg % 360) + 360) % 360;
    const choices = [
      { d: 45, ch: '↘' },
      { d: 135, ch: '↙' },
      { d: 225, ch: '↖' },
      { d: 315, ch: '↗' }
    ];
    let best = choices[0], min = 1e9;
    for (const c of choices) {
      let diff = Math.abs(a - c.d);
      diff = Math.min(diff, 360 - diff);
      if (diff < min) { min = diff; best = c; }
    }
    return best.ch;
  }

  // — met à jour les flèches des 4 poignées en fonction de la rotation du meuble
  function updateResizeHandleArrowsFor(el) {
    const rot = parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0;
    const BASE = { nw: 225, ne: 315, se: 45, sw: 135 }; // diagonales “extérieures” à 0°

    el.querySelectorAll('.rz').forEach(h => {
      const dir = (h.dataset.dir || '').toLowerCase();
      const base = BASE[dir] ?? 45;
      const arrow = diagArrowFor(base + rot);

      let ic = h.querySelector('.rz_icon');
      if (!ic) {
        ic = document.createElement('span');
        ic.className = 'rz_icon';
        ic.style.position = 'absolute';
        ic.style.left = '50%';
        ic.style.top = '50%';
        ic.style.transform = 'translate(-50%, -50%)';
        ic.style.fontSize = Math.max(10, unitPx * 0.25) + 'px';
        ic.style.fontWeight = '700';
        ic.style.userSelect = 'none';
        ic.style.pointerEvents = 'none';
        ic.style.lineHeight = '1';
        h.appendChild(ic);
      } else {
        // si l'échelle change (fit), recalcule la taille
        ic.style.fontSize = Math.max(10, unitPx * 0.25) + 'px';
      }
      ic.textContent = arrow;
    });
  }

  // [2] ----------------------------------------------------------------------
  // API Client
  // -------------------------------------------------------------------------

  const api = {
    getAll: (planId) => {
      const q = planId ? `?plan_id=${encodeURIComponent(planId)}` : '';
      return fetch(`${API_BASE}/plans/${classeId}${q}`, {
        credentials: 'same-origin',
        cache: 'no-store'
      }).then(jsonIfAny);
    },

    create: (payload) =>
      fetchWithCsrf(`${API_BASE}/plans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(jsonIfAny),

    activate: (plan_id) =>
      fetchWithCsrf(`${API_BASE}/plans/${plan_id}/activate`, {
        method: 'PUT'
      }).then(jsonIfAny),

    duplicate: (plan_id) =>
      fetchWithCsrf(`${API_BASE}/plans/${plan_id}/duplicate`, {
        method: 'POST'
      }).then(jsonIfAny),

    reset: (plan_id, full = false) =>
      fetchWithCsrf(`${API_BASE}/plans/${plan_id}/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full: !!full })
      }).then(jsonIfAny),

    savePositions: (plan_id, items) =>
      fetchWithCsrf(`${API_BASE}/plans/${plan_id}/positions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions: items })
      }).then(jsonIfAny),

    deletePosition: (plan_id, eleve_id) =>
      fetchWithCsrf(`${API_BASE}/plans/${plan_id}/positions`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eleve_id })
      }).then(jsonIfAny),

    saveFurniture: (plan_id, items) =>
      fetchWithCsrf(`${API_BASE}/plans/${plan_id}/furniture`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ furniture: items })
      }).then(jsonIfAny),

    deleteFurniture: (plan_id, item_id) =>
      fetchWithCsrf(`${API_BASE}/plans/${plan_id}/furniture/${item_id}`, {
        method: 'DELETE'
      }).then(jsonIfAny),

    saveWalls: (plan_id, walls) =>
      fetchWithCsrf(`${API_BASE}/plans/${plan_id}/walls`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walls })
      }).then(jsonIfAny),

    // facultatif : delete plan via SEATING_URLS.deletePlan si présent
    deletePlan: async (planId) => {
      if (!Number.isFinite(+planId) || +planId <= 0) return false;

      if (window.SEATING_URLS?.deletePlan) {
        const url = window.SEATING_URLS.deletePlan(planId);

        // a) Essai POST (souvent protégé CSRF)
        let r = await fetchWithCsrf(url, {
          method: 'POST',
          headers: { 'Accept': 'application/json' }
        });
        if (r.ok) return true;

        // b) Method override
        r = await fetchWithCsrf(url, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: '_method=DELETE'
        });
        if (r.ok) return true;

        // c) DELETE direct
        r = await fetchWithCsrf(url, {
          method: 'DELETE',
          headers: { 'Accept': 'application/json' }
        });
        return r.ok;
      }

      // 2) Fallback API REST
      const r = await fetchWithCsrf(`${API_BASE}/plans/${planId}`, {
        method: 'DELETE',
        headers: { 'Accept': 'application/json' }
      });
      return r.ok;
    }
  };

  // [3] ----------------------------------------------------------------------
  // Autosave (debounce) & resync contrôlé
  // -------------------------------------------------------------------------

  const debounce = (fn, d = 600) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), d);
    };
  };


  const autosavePositions = debounce(() => {
    if (!state.active_plan) return;
    const payload = state.positions.map(p => {
      const raw = p.rotAbs ?? p.rot ?? 0;
      const r = norm360(Math.round(raw));
      return {
        eleve_id: p.eleve_id,
        x: Math.round(p.x * PLAN_SUBDIV),
        y: Math.round(p.y * PLAN_SUBDIV),
        seat_id: p.seat_id ?? null,
        rotation: r,
        rot: r
      };
    });
    api.savePositions(state.active_plan.id, payload).catch(console.error);
  }, 500);

  // autosave meubles (resync uniquement si création, jamais pendant un drag)
  // autosave meubles (resync uniquement si création, jamais pendant un drag)
  const autosaveFurniture = (() => {
    let timer = null;
    return () => {
      if (!state.active_plan) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          // 1) ne renvoyer qu’une fois les créations (uid) dans une même fenêtre de debounce
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
              rotation: round1(norm360(f.rotAbs ?? f.rotation ?? 0)),

              z: f.z || 0,
              radius: !!f.radius
            }));

          if (!payload.length) return;

          // 2) marquer les créations contenues dans ce lot
          const createdUIDs = payload.filter(p => !p.id && p.client_uid).map(p => p.client_uid);
          createdUIDs.forEach(uid => sentNewFurniture.add(uid));

          // 3) PUT
          await api.saveFurniture(state.active_plan.id, payload);

          // 4) si on vient de créer, résync rapide (sauf pendant un drag)
          if (createdUIDs.length && !isDraggingNow) {
            pendingSelSnap = selectionSnapshot();
            resyncSoon(0);
          }
        } catch (err) {
          console.error('[autosaveFurniture] PUT failed', err);
          // on laisse une chance de renvoyer à la prochaine fenêtre
          sentNewFurniture.clear();
        }
      }, 500);
    };
  })();


  // autosave murs (déplacés au clavier)
  const autosaveWalls = debounce(async () => {
    if (!state.active_plan) return;
    dedupeWallsInState();
    const planId = state.active_plan.id;
    const payloadWalls = encodeWallsForStorage(state.walls);
    try { await api.saveWalls?.(planId, payloadWalls); } catch (e) { console.warn('saveWalls API KO', e); }
    try { localStorage.setItem(`pc_walls_${planId}`, JSON.stringify(payloadWalls)); } catch { }
  }, 500);

  // sauvegarde immédiate d'un meuble (pour couleur etc.)
  async function saveFurnitureItemImmediate(f) {
    if (!state.active_plan || !f) return;
    const payload = [{
      id: (f.id && f.id > 0) ? f.id : undefined,
      client_uid: f.uid ?? null,
      type: f.type,
      label: f.label,
      color: f.color || FURN_COLORS[f.type] || null,
      x: Math.round(f.x * PLAN_SUBDIV),
      y: Math.round(f.y * PLAN_SUBDIV),
      w: Math.round(f.w * PLAN_SUBDIV),
      h: Math.round(f.h * PLAN_SUBDIV),
      rotation: round1(norm360(f.rotAbs ?? f.rotation ?? 0)),

      z: f.z || 0,
      radius: !!f.radius
    }];
    try { await api.saveFurniture(state.active_plan.id, payload); } catch (e) { console.error(e); }
  }

  let resyncTimer = null;
  function resyncSoon(delay = 600) {
    clearTimeout(resyncTimer);
    if (isDraggingNow) return;
    if (!pendingSelSnap) pendingSelSnap = selectionSnapshot();
    resyncTimer = setTimeout(() => boot().catch(console.error), delay);
  }

  // [4] ----------------------------------------------------------------------
  // Stage fit + Grille + Fullscreen
  // -------------------------------------------------------------------------

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

    if (!$svg) {
      $svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      $svg.setAttribute('id', 'pc_svg');
      $svg.classList.add('pc_svg');
      $stage.appendChild($svg);
    }
    $svg.style.position = 'absolute';
    $svg.style.left = '0';
    $svg.style.top = '0';
    $svg.style.width = '100%';
    $svg.style.height = '100%';
    $svg.style.pointerEvents = 'auto';

    ensureHatchPattern();
    // Recalibre le border-radius (px) après changement d'échelle
    $stage.querySelectorAll('.pc_furn').forEach(el => {
      const id = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
      const f = (id != null) ? state.furniture.find(x => x.id === id) : null;
      applyCornerRadiusPx(el, f);
      updateResizeHandleArrowsFor(el);
    });
  }

  function refreshDomScaleFromState() {
    // Meubles
    for (const f of state.furniture) {
      const el = $stage.querySelector(`.pc_furn[data-id="${f.id}"]`);
      if (!el) continue;
      el.style.left = `${toPx(f.x)}px`;
      el.style.top = `${toPx(f.y)}px`;
      el.style.width = `${toPx(f.w)}px`;
      el.style.height = `${toPx(f.h)}px`;
      // la rotation est déjà stockée dans data-attrs :
      const rot = parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0;
      el.style.transform = `rotate(${rot}deg)`;
      applyCornerRadiusPx(el, f);
    }

    // Cartes élèves (si tu veux les rescaler aussi)
    for (const p of state.positions) {
      const card = $stage.querySelector(`.pc_card[data-eleve-id="${p.eleve_id}"]`);
      if (!card) continue;
      const Wpx = toPx(STUDENT_W_CM / CM_PER_UNIT);
      const Hpx = toPx(STUDENT_H_CM / CM_PER_UNIT);
      card.style.left = `${toPx(p.x)}px`;
      card.style.top = `${toPx(p.y)}px`;
      card.style.width = `${Wpx}px`;
      card.style.height = `${Hpx}px`;
      const rot = (p.rotAbs ?? p.rot ?? 0);
      card.style.transform = `rotate(${rot}deg)`;
    }
  }



  function ensureHatchPattern() {
    if (!$svg) return;
    let defs = $svg.querySelector('defs');
    if (!defs) { defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); $svg.appendChild(defs); }
    if ($svg.querySelector('#hatch')) return;
    const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
    pattern.setAttribute('id', 'hatch');
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    pattern.setAttribute('width', '8');
    pattern.setAttribute('height', '8');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M-2,2 l4,-4 M0,8 l8,-8 M6,10 l4,-4');
    path.setAttribute('stroke', '#334155');
    path.setAttribute('stroke-width', '1');
    defs.appendChild(pattern); pattern.appendChild(path);
  }

  function setupFullscreenExact($wrap, onFit, onRender) {
    const btn = document.getElementById('pc_fullscreen');
    if (!$wrap || !btn) return;

    function enter() { if ($wrap.requestFullscreen) $wrap.requestFullscreen(); }
    function exit() { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); }

    btn.addEventListener('click', () => { if (document.fullscreenElement) exit(); else enter(); });
    document.addEventListener('fullscreenchange', () => {
      try { onFit && onFit(); } catch { }
      try { onRender && onRender(); } catch { }
    });
  }

  // [5] ----------------------------------------------------------------------
  // Collisions & collapse
  // -------------------------------------------------------------------------

  function clampToStage(gx, gy, wUnits, hUnits) {
    if (!state.active_plan) return { gx, gy };
    const W = state.active_plan.width, H = state.active_plan.height;
    return { gx: Math.max(0, Math.min(gx, W - wUnits)), gy: Math.max(0, Math.min(gy, H - hUnits)) };
  }

  function rectsInPlan(exclude = {}) {
    const rects = [];
    const fp = studentFootprintUnits();

    for (const p of state.positions) {
      if (exclude.eleveId && p.eleve_id === exclude.eleveId) continue;
      const rot = (p.rotAbs ?? p.rot ?? 0);
      const r = rectFromTopLeftWithRotation(p.x, p.y, fp.w, fp.h, rot);
      rects.push({ ...r, kind: 'eleve', id: p.eleve_id });
    }

    for (const f of state.furniture) {
      if (exclude.furnitureId && f.id === exclude.furnitureId) continue;
      const rot = (f.rotAbs ?? f.rotation ?? 0);
      const r = rectFromTopLeftWithRotation(f.x, f.y, f.w, f.h, rot);
      rects.push({ ...r, kind: 'furniture', id: f.id });
    }

    return rects;
  }

  const notOverlap = (a, b) =>
    (a.x + a.w) <= b.x + EPS || (b.x + b.w) <= a.x + EPS ||
    (a.y + a.h) <= b.y + EPS || (b.y + b.h) <= a.y + EPS;

  const collides = (r, others) => others.some(o => !notOverlap(r, o));

  function snapCollapse(r, others) {
    const margin = TICK + 1e-9;
    const tol = TICK * 0.5;
    const onTick = v => Math.round(v * UI_SUBDIV) / UI_SUBDIV;
    const overlap1D = (a0, a1, b0, b1) => !(a1 <= b0 + tol || b1 <= a0 + tol);

    let best = null;
    const consider = (nx, ny) => {
      const cand = { x: onTick(nx), y: onTick(ny), w: r.w, h: r.h };
      const c = clampToStage(cand.x, cand.y, r.w, r.h);
      const snapped = { x: c.gx, y: c.gy, w: r.w, h: r.h };
      if (collides(snapped, others)) return;
      const d = Math.abs(snapped.x - r.x) + Math.abs(snapped.y - r.y);
      if (!best || d < best.d) best = { ...snapped, d };
    };

    for (const o of others) {
      if (overlap1D(r.y, r.y + r.h, o.y, o.y + o.h)) {
        const gapRight = o.x - (r.x + r.w);
        const gapLeft = (o.x + o.w) - r.x;
        if (Math.abs(gapRight) <= margin) consider(o.x - r.w, r.y);
        if (Math.abs(gapLeft) <= margin) consider(o.x + o.w, r.y);
      }
      if (overlap1D(r.x, r.x + r.w, o.x, o.x + o.w)) {
        const gapBottom = o.y - (r.y + r.h);
        const gapTop = (o.y + o.h) - r.y;
        if (Math.abs(gapBottom) <= margin) consider(r.x, o.y - r.h);
        if (Math.abs(gapTop) <= margin) consider(r.x, o.y + o.h);
      }
    }

    if (state.active_plan) {
      const W = state.active_plan.width, H = state.active_plan.height;
      const dLeft = 0 - r.x;
      const dRight = (W - (r.x + r.w));
      const dTop = 0 - r.y;
      const dBottom = (H - (r.y + r.h));
      if (Math.abs(dLeft) <= margin) consider(0, r.y);
      if (Math.abs(dRight) <= margin) consider(W - r.w, r.y);
      if (Math.abs(dTop) <= margin) consider(r.x, 0);
      if (Math.abs(dBottom) <= margin) consider(r.x, H - r.h);
    }

    return best ? { x: best.x, y: best.y, w: r.w, h: r.h } : r;
  }

  function findNearestFreeSpot(gx, gy, wUnits, hUnits, exclude = {}) {
    const others = rectsInPlan(exclude);
    const tryPlace = (x, y) => {
      const c = clampToStage(x, y, wUnits, hUnits);
      const r = { x: c.gx, y: c.gy, w: wUnits, h: hUnits };
      return collides(r, others) ? null : r;
    };
    let r = tryPlace(gx, gy); if (r) return r;
    const W = state.active_plan?.width || 30;
    const H = state.active_plan?.height || 20;
    const maxR = Math.max(80, Math.ceil((W + H) * UI_SUBDIV / 2));
    for (let d = 1; d <= maxR; d++) {
      for (let dx = -d; dx <= d; dx++) {
        for (let dy = -d; dy <= d; dy++) {
          if (Math.abs(dx) !== d && Math.abs(dy) !== d) continue;
          const x = snapUnits(gx + dx * TICK), y = snapUnits(gy + dy * TICK);
          r = tryPlace(x, y); if (r) return r;
        }
      }
    }
    return null;
  }

  const shake = el => { el.classList.add('pc_shake'); setTimeout(() => el.classList.remove('pc_shake'), 250); };

  // [6] ----------------------------------------------------------------------
  // Rendu: élèves, meubles, murs, palette
  // -------------------------------------------------------------------------

  function renderPlansSelect() {
    if (!$sel) return; $sel.innerHTML = '';
    for (const p of state.plans) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = (p.is_active ? '★ ' : '') + `${p.name} — ${new Date(p.created_at).toLocaleDateString()}`;
      if (state.active_plan && p.id === state.active_plan.id) o.selected = true;
      $sel.appendChild(o);
    }
  }

  function clearStage() {
    $stage.querySelectorAll('.pc_card, .pc_furn').forEach(n => n.remove());
    if ($svg) {
      // Supprime tout SAUF <defs>, la surface de clic, et la poignée AutoWalls
      Array.from($svg.childNodes).forEach(n => {
        if (n.tagName === 'defs') return;
        if (n.matches?.('rect.pc-click-surface, #aw_start_handle')) return;
        n.remove();
      });
      ensureHatchPattern();
    }
  }


  function moyClass(m20) { if (m20 == null) return ''; if (m20 >= 16) return 'mAp'; if (m20 >= 13) return 'mA'; if (m20 >= 8) return 'mPA'; return 'mNA'; }

  // --- rotation élève: snap 0/90/270 (évite 180)
  function snapRotStudent(deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d < 45 || d >= 315) return 0;
    if (d < 135) return 90;
    return 270;
  }

  function onCardAltWheel(e) {
    if (!e.altKey) return;
    e.preventDefault();
    const card = e.currentTarget;
    setCardRotation(card, (e.deltaY > 0 ? -1 : 1), { snap: false });
  }

  function refreshCardRotateButtons(card) {
    const leftBtn = card.querySelector('.pc_rot_btn.rot-left');
    const rightBtn = card.querySelector('.pc_rot_btn.rot-right');
    if (!leftBtn || !rightBtn) return;

    let visu = parseFloat(card.dataset.rotVisuAbs || card.dataset.rotAbs || '0') || 0;
    if (visu === 270) visu = -90; // normalise 270 → -90 côté UI

    if (visu === 0) {
      leftBtn.style.display = "inline-block";
      rightBtn.style.display = "inline-block";
    } else if (visu === -90) {
      leftBtn.style.display = "none";
      rightBtn.style.display = "inline-block";
    } else if (visu === 90) {
      rightBtn.style.display = "none";
      leftBtn.style.display = "inline-block";
    } else {
      leftBtn.style.display = "inline-block";
      rightBtn.style.display = "inline-block";
    }
  }

  function buildRotateControls(card) {
    const nameEl = card.querySelector('.pc_name_in');
    if (!nameEl) return;
    if (nameEl.querySelector('.pc_rot_btn')) return;

    const mk = (cls, title, delta) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `pc_rot_btn ${cls}`;
      b.textContent = (delta < 0 ? '↺' : '↻');
      b.title = title;
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.addEventListener('mousedown', e => e.stopPropagation());
      b.addEventListener('click', e => e.stopPropagation());
      b.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
      b.addEventListener('click', () => setCardRotation(card, delta, { snap: true }));
      return b;
    };

    nameEl.prepend(mk('rot-left', 'Pivoter -90°', -90));
    nameEl.append(mk('rot-right', 'Pivoter +90°', +90));

    if (!card._wheelBound) {
      card.addEventListener('wheel', onCardAltWheel, { passive: false });
      card._wheelBound = true;
    }
  }

  function refreshToolbarActionsEnabled() {
    const has = !!($sel && $sel.value);
    ['pc_activate', 'pc_duplicate', 'pc_delete_plan', 'pc_export_pdf', 'pc_reset_plan']
      .forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !has; });
  }

  // cartes (élèves)
  function setCardRotation(card, delta, { snap = false } = {}) {
    let visu = parseFloat(card.dataset.rotVisuAbs || card.dataset.rotAbs || card.dataset.rot || '0') || 0;
    visu += delta;
    if (snap) { if (visu > 90) visu = 90; if (visu < -90) visu = -90; }

    const snapAbs = snapRotStudent(visu);

    card.dataset.rotVisuAbs = String(visu);
    card.dataset.rotAbs = String(snapAbs);
    card.dataset.rot = String(snapAbs);
    card.style.transformOrigin = 'center center';
    card.style.transform = `rotate(${visu}deg)`;  // affichage continu

    const eleveId = parseInt(card.dataset.eleveId, 10);
    const p = state.positions.find(x => x.eleve_id === eleveId);
    if (p) {
      p.rotAbs = snapAbs;
      p.rot = snapAbs;
      if (state.active_plan) lsSetPosRot(state.active_plan.id, eleveId, snapAbs);
      autosavePositions();
    }

    const leftBtn = card.querySelector('.pc_rot_btn.rot-left');
    const rightBtn = card.querySelector('.pc_rot_btn.rot-right');
    if (leftBtn && rightBtn) refreshCardRotateButtons(card);
  }

  function addDeleteButton(el) {
    const btn = document.createElement('div');
    btn.className = 'pc_delete_btn';
    btn.textContent = '×';
    btn.title = 'Supprimer';
    btn.addEventListener('click', (e) => { e.stopPropagation(); removeElement(el); });
    el.appendChild(btn);
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

    card.style.left = `${toPx(pos.x)}px`;
    card.style.top = `${toPx(pos.y)}px`;
    card.title = `${eleve.prenom || ''} ${eleve.nom || ''}`.trim();

    const fp = studentFootprintUnits();
    card.style.width = `${toPx(fp.w)}px`;
    card.style.height = `${toPx(fp.h)}px`;

    const inner = document.createElement('div');
    inner.className = 'pc_card_in';

    const initRotAbs = Number.isFinite(pos.rotAbs ?? pos.rot) ? (pos.rotAbs ?? pos.rot) : 0; // 0/90/270
    const initVisu = (initRotAbs === 270) ? -90 : initRotAbs; // -90/0/90
    card.dataset.rotAbs = String(initRotAbs);
    card.dataset.rotVisuAbs = String(initVisu);
    card.dataset.rot = String(initRotAbs);
    card.style.transformOrigin = 'center center';
    card.style.transform = `rotate(${initVisu}deg)`;

    const img = document.createElement('img');
    img.src = PHOTOS_BASE + (eleve.photo_filename || 'default.jpg');
    img.draggable = card.draggable = false;
    img.addEventListener('dragstart', ev => ev.preventDefault());
    card.addEventListener('dragstart', ev => ev.preventDefault());

    const name = document.createElement('div');
    name.className = 'pc_name_in';
    name.textContent = eleve.prenom || '';
    const sexCls = (eleve.sexe === 'FEMININ' || eleve.sexe === 'F') ? 'sex-fille'
      : (eleve.sexe === 'MASCULIN' || eleve.sexe === 'M') ? 'sex-garcon' : '';
    if (sexCls) name.classList.add(sexCls);

    const bM = document.createElement('div');
    bM.className = `badge moy ${moyClass(eleve.moyenne_20)}`;
    bM.textContent = (eleve.moyenne_20 != null) ? Math.round(eleve.moyenne_20) : '—';

    inner.append(img, name);
    card.append(bM, inner);

    buildRotateControls(card);
    refreshCardRotateButtons(card);
    addDeleteButton(card);

    card.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return;
      if (e.target.closest('.pc_delete_btn') || e.target.closest('.pc_rot_btn')) return;
      selectNodeOnPointerDown(card, e);
      startDragCard(e);
    });

    $stage.appendChild(card);
  }

  // meubles
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
  function addFurnRotate(el) {
    const btn = document.createElement('div');
    btn.className = 'pc_delete_btn';
    btn.style.right = '26px';
    btn.title = 'Pivoter (90°) — Alt+molette: rotation fine';
    btn.textContent = '↻';
    btn.addEventListener('click', (e) => { e.stopPropagation(); setFurnitureRotation(el, 90); });
    el.addEventListener('wheel', (e) => { if (!e.altKey) return; e.preventDefault(); setFurnitureRotation(el, (e.deltaY > 0 ? -0.1 : 0.1)); }, { passive: false });
    el.appendChild(btn);
  }
  function addFurnCornerToggle(el) {
    if (el.dataset.furnitureType === 'table_round') return;
    let btn = el.querySelector('.pc_corner_btn');
    if (!btn) {
      btn = document.createElement('div');
      btn.className = 'pc_corner_btn';
      btn.title = 'Coins arrondis/carrés';
      btn.textContent = '◻︎';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
        const f = (id != null) ? state.furniture.find(x => x.id === id) : null;
        if (!f) return;
        f.radius = !f.radius;
        applyCornerRadiusPx(el, f);
        btn.textContent = f.radius ? '◯' : '◻︎';
        saveFurnitureItemImmediate(f);
      });
      el.appendChild(btn);
    }
    btn.style.display = editMode ? 'block' : 'none';
  }
  function setFurnitureRotation(el, delta) {
    const cur = parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0;
    const abs = round1(cur + delta);           // ← garde 0,1°
    const norm = round1(norm360(abs));         // ← 0..360 à 0,1°

    el.dataset.rotAbs = String(abs);
    el.dataset.rot = String(norm);
    el.style.transform = `rotate(${abs}deg)`;

    const id = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
    const f = (id != null) ? state.furniture.find(x => x.id === id) : null;
    if (f) {
      f.rotAbs = abs;       // valeur exacte affichée
      f.rotation = norm;    // version normalisée
      autosaveFurniture();
    }

    updateResizeHandleArrowsFor(el);
    updateFurnitureMeasures(el);
  }

  function addFurnitureColorBtn(el) {
    const id = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
    const f = (id != null) ? state.furniture.find(x => x.id === id) : null;

    let pick = el.querySelector('.pc_col_btn');
    if (!pick) {
      pick = document.createElement('input');
      pick.type = 'color';
      pick.className = 'pc_col_btn';
      pick.addEventListener('pointerdown', e => e.stopPropagation());
      pick.addEventListener('click', e => e.stopPropagation());
      el.appendChild(pick);
    }
    const isPersisted = !!(id && id > 0);
    pick.disabled = !isPersisted;
    pick.title = isPersisted ? 'Couleur du meuble' : 'Enregistrement en cours…';
    pick.style.opacity = isPersisted ? '1' : '.5';
    pick.style.cursor = isPersisted ? 'pointer' : 'not-allowed';

    const current = (f?.color) || '#ffffff';
    pick.value = current;

    pick.oninput = () => {
      if (!isPersisted) return;
      const ff = state.furniture.find(x => x.id === id);
      if (ff) {
        ff.color = pick.value;
        applyFurnitureColor(el, ff.type || el.dataset.furnitureType || 'autre', ff.color);
        lsSetColor(state.active_plan.id, id, ff.color);
        saveFurnitureItemImmediate(ff);
      }
    };
  }
  function refreshFurnitureEditability() {
    document.body.classList.toggle('pc_edit_on', !!editMode);
    $stage.querySelectorAll('.pc_furn').forEach(el => {
      el.querySelectorAll('.rz').forEach(h => {
        h.style.pointerEvents = editMode ? 'auto' : 'none';
        h.style.opacity = editMode ? '1' : '0';
      });
      const hasBtn = !!el.querySelector('.pc_col_btn');
      if (editMode) { if (!hasBtn) addFurnitureColorBtn(el); }
      else { if (hasBtn) el.querySelector('.pc_col_btn').remove(); }
      addFurnCornerToggle(el);
    });
    if ($edit) $edit.textContent = 'Édition meubles : ' + (editMode ? 'ON' : 'OFF');
    $stage.querySelectorAll('.pc_furn').forEach(updateResizeHandleArrowsFor);
  }

  // ---------- Copier / Coller (meubles) ----------
  let _clipboardFurn = [];                 // tampon local
  const PASTE_OFFSET_PX = (window.SEATING_CONF?.grid ?? 32); // 1 grille de décalage
  const PASTE_OFFSET_UNITS = (typeof unitPx === 'number' && unitPx > 0)
    ? (PASTE_OFFSET_PX / unitPx)
    : (PASTE_OFFSET_PX / 10 / (typeof CM_PER_UNIT === 'number' && CM_PER_UNIT > 0 ? CM_PER_UNIT : 1)); // fallback

  function pxToUnits(v) {
    if (typeof unitPx === 'number' && unitPx > 0) return v / unitPx;
    // fallback 10 px = 1 cm
    const cm = v / 10;
    return (typeof CM_PER_UNIT === 'number' && CM_PER_UNIT > 0) ? (cm / CM_PER_UNIT) : cm;
  }
  function unitsToPx(v) {
    if (typeof unitPx === 'number' && unitPx > 0) return v * unitPx;
    // fallback 10 px = 1 cm
    const cm = (typeof CM_PER_UNIT === 'number' && CM_PER_UNIT > 0) ? (v * CM_PER_UNIT) : v;
    return cm * 10;
  }

  // Extrait un modèle "meuble" (en unités) depuis l'élément DOM .pc_furn
  function furnitureModelFromEl(el) {
    const id = el.dataset.id || el.getAttribute('data-id') || (el.id || '').replace(/^f_/, '');
    const type = el.dataset.type || el.getAttribute('data-type') || 'furniture';

    const L = parseFloat(el.style.left || '0');
    const T = parseFloat(el.style.top || '0');
    const W = parseFloat(el.style.width || '0');
    const H = parseFloat(el.style.height || '0');

    const rot = parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0;

    // En unités plan
    return {
      id,
      type,
      x: pxToUnits(L),
      y: pxToUnits(T),
      w: pxToUnits(W),
      h: pxToUnits(H),
      rot
    };
  }

  // Ajoute un meuble au state et déclenche le rendu

  function addFurnitureFromModelReturnId(m) {
    state.furniture || (state.furniture = []);

    const uid = (typeof genUid === 'function') ? genUid() :
      ('u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const id = (typeof tempIdSeq === 'number') ? (tempIdSeq--) : (-Math.floor(Math.random() * 1e6));

    const copy = {
      ...m,
      id,
      uid,               // très important pour la réconciliation post-save
      rotation: (m.rot ?? m.rotation ?? 0),
      rotAbs: (m.rot ?? m.rotation ?? 0),
      z: 0,
      radius: !!m.radius
    };

    state.furniture.push(copy);

    // Rendu immédiat
    if (typeof renderFurniture === 'function') { renderFurniture(); }
    else if (typeof render === 'function') { render(); }

    // Sauvegarde incrémentale (laisse l’API créer l’id serveur et nous renvoyer client_uid)
    try { autosaveFurniture?.(); } catch (e) { console.warn('autosaveFurniture failed', e); }

    return id;
  }



  // Copie tous les meubles sélectionnés
  function copySelectedFurniture() {
    const src = window.selection || selection;
    let furnNodes = Array.from(src || []).filter(n => n.classList?.contains('pc_furn'));
    if (!furnNodes.length) return;

    // S’il y a plusieurs meubles sélectionnés mais qu’on a un dernier cliqué,
    // on ne copie QUE celui-là (évite de recopier l’ancien meuble).
    if (furnNodes.length > 1 && window._lastClickedFurn && furnNodes.includes(window._lastClickedFurn)) {
      furnNodes = [window._lastClickedFurn];
    }


    _clipboardFurn = furnNodes.map(furnitureModelFromEl);
  }



  // Colle (duplique) les meubles copiés, avec un petit décalage
  function pasteClipboardFurniture() {
    if (!_clipboardFurn.length) return;

    const newIds = [];
    for (const m of _clipboardFurn) {
      const dm = { ...m, x: m.x + PASTE_OFFSET_UNITS, y: m.y + PASTE_OFFSET_UNITS };

      // on intercepte l'id généré par addFurnitureFromModel
      const newId = addFurnitureFromModelReturnId(dm);
      if (newId) newIds.push(newId);
    }

    // Sélection propre : uniquement les copies
    if (newIds.length) {
      clearSelection();
      newIds.forEach(id => {
        const el = document.querySelector(`.pc_furn[data-id="${id}"]`);
        if (el) selectNode(el, true);
      });
    }

  }

  // ====== Copie/Coller meubles : priorité à la scène ======
  (function setupCopyPasteScope() {
    const stage = document.getElementById('pc_stage');
    stage?.querySelectorAll('.pc_furn').forEach(n => n.remove());
    if (!stage) return;

    // 1) Savoir si on est "armé" (souris sur la scène ou on a cliqué dedans)
    let HOTKEYS_ARMED = false;

    const isEditable = (t) => {
      if (!t) return false;
      if (t.isContentEditable) return true;
      const tn = (t.tagName || '').toUpperCase();
      return tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT';
    };

    stage.addEventListener('pointerenter', () => { HOTKEYS_ARMED = true; });
    stage.addEventListener('pointerleave', () => { HOTKEYS_ARMED = false; });

    // Quand on clique dans la scène : on "prend la main" et on blur les inputs
    stage.addEventListener('pointerdown', () => {
      HOTKEYS_ARMED = true;
      const ae = document.activeElement;
      if (isEditable(ae)) ae.blur();
    });

    // 2) Intercepter globalement Ctrl+C / Ctrl+V si la scène est armée
    window.addEventListener('keydown', (e) => {
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;

      const code = e.code; // 'KeyC', 'KeyV' (robuste AZERTY/QWERTY)

      // On n’active copier/coller meubles QUE si la scène est armée
      if (!HOTKEYS_ARMED) return;

      // S'il y a un input focus mais on est armé, on prend la priorité
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();

      if (code === 'KeyC') {
        // Copier uniquement les meubles sélectionnés
        if (window.selection && Array.from(selection).some(n => n.classList?.contains('pc_furn'))) {
          copySelectedFurniture();
        }
        return;
      }
      if (code === 'KeyV') {
        pasteClipboardFurniture();
        return;
      }
    }, { capture: true }); // capture = on passe avant les champs/handlers
  })();





  function makeStudentGhost(eleve) {
    const ghost = document.createElement('div');
    ghost.className = 'pc_card';
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    ghost.style.opacity = '0.8';
    ghost.style.zIndex = '9999';

    const fp = studentFootprintUnits();
    ghost.style.width = `${toPx(fp.w)}px`;
    ghost.style.height = `${toPx(fp.h)}px`;

    const inner = document.createElement('div');
    inner.className = 'pc_card_in';

    const img = document.createElement('img');
    img.src = PHOTOS_BASE + (eleve.photo_filename || 'default.jpg');

    const name = document.createElement('div');
    name.className = 'pc_name_in';
    name.textContent = eleve.prenom || '';

    const sexCls = (eleve.sexe === 'FEMININ' || eleve.sexe === 'F') ? 'sex-fille'
      : (eleve.sexe === 'MASCULIN' || eleve.sexe === 'M') ? 'sex-garcon' : '';
    if (sexCls) name.classList.add(sexCls);

    inner.append(img, name);
    ghost.append(inner);
    return ghost;
  }

  function makeFurnitureGhost(type, wUnits, hUnits) {
    const t = (type || 'autre').toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/\s+/g, '_');
    const ghost = document.createElement('div');
    ghost.className = `pc_furn preview type-${t}`;
    ghost.style.position = 'fixed';
    ghost.style.pointerEvents = 'none';
    ghost.style.opacity = '0.75';
    ghost.style.zIndex = '9999';
    ghost.style.width = `${toPx(wUnits)}px`;
    ghost.style.height = `${toPx(hUnits)}px`;
    ghost.style.transformOrigin = 'center center';
    ghost.style.borderStyle = 'dashed';
    const c = FURN_COLORS[t] || FURN_DEF_COLORS[t] || '#fff';
    ghost.style.background = c; ghost.style.borderColor = darken(c, .22);
    const lab = document.createElement('div'); lab.className = 'label';
    lab.textContent = (t === 'table_rect' ? 'Table' : t === 'table_round' ? 'Table ronde' : t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' '));
    ghost.appendChild(lab);
    return ghost;
  }

  function renderFurniture() {
    for (const f of (state.furniture || [])) {
      const el = document.createElement('div');
      el.className = 'pc_furn';
      el.dataset.type = 'furniture';
      el.dataset.id = (f.id != null) ? String(f.id) : '';
      const t = (f.type || 'autre').toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/\s+/g, '_');
      el.dataset.furnitureType = t;
      el.classList.add(`type-${t}`);
      el.addEventListener('mouseenter', () => showFurnitureMeasures(el));
      el.addEventListener('mouseleave', () => hideFurnitureMeasures(el));

      if (f.rotation != null) el.dataset.rot = String(f.rotation);
      if (f.rotAbs != null) el.dataset.rotAbs = String(f.rotAbs);
      el.style.transformOrigin = 'center center';
      el.style.transform = `rotate(${el.dataset.rotAbs || el.dataset.rot || 0}deg)`;

      el.style.left = `${toPx(f.x)}px`;
      el.style.top = `${toPx(f.y)}px`;
      el.style.width = `${toPx(f.w)}px`;
      el.style.height = `${toPx(f.h)}px`;

      applyCornerRadiusPx(el, f);

      const color = f.color || FURN_COLORS[t] || null; if (color) applyFurnitureColor(el, t, color);

      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = f.label || f.type || 'meuble';
      // centrer + lisible, sans bloquer les clics
      label.style.position = 'absolute';
      label.style.left = '50%';
      label.style.top = '50%';
      label.style.transform = 'translate(-50%, -50%)';
      label.style.pointerEvents = 'none';
      label.style.fontWeight = '600';
      label.style.fontSize = Math.max(10, unitPx * 0.33) + 'px';
      label.style.padding = '2px 6px';
      label.style.borderRadius = '6px';
      label.style.border = '1px solid rgba(0,0,0,.08)';
      el.append(label);


      const makeHandle = dir => { const h = document.createElement('div'); h.className = `rz ${dir}`; h.dataset.dir = dir; h.title = 'Redimensionner'; h.addEventListener('pointerdown', startResizeFurniture); return h; };

      el.append(label, makeHandle('nw'), makeHandle('ne'), makeHandle('se'), makeHandle('sw'));
      addDeleteButton(el); addFurnRotate(el); addFurnCornerToggle(el);
      // oriente les flèches des poignées selon la rotation actuelle
      updateResizeHandleArrowsFor(el);
      el.addEventListener('pointerdown', (e) => {
        if (e.button && e.button !== 0) return;
        if (e.target.closest('.pc_delete_btn')) return;
        if (e.target.classList.contains('rz')) return;
        selectNodeOnPointerDown(el, e);
        startDragFurniture(e);
      });

      $stage.appendChild(el);

      el.querySelectorAll('.rz').forEach(h => {
        h.style.pointerEvents = editMode ? 'auto' : 'none';
        h.style.opacity = editMode ? '1' : '0';
      });
      if (editMode) addFurnitureColorBtn(el);
    }
  }

  // --- Tri & groupement de la palette d'élèves : par niveau, prénoms A→Z
  function renderEleveList() {
    if (!$elist) return;
    $elist.innerHTML = '';

    // 1) Élèves déjà placés à exclure de la palette
    const placed = new Set(state.positions.map(p => p.eleve_id));

    // 2) Regrouper par niveau
    const groups = new Map(); // niveau -> Array<eleve>
    state.eleves.forEach(e => {
      if (placed.has(e.id)) return;
      const nivRaw = (e.niveau || '').toString().trim();
      const niveau = nivRaw || 'Autres';
      if (!groups.has(niveau)) groups.set(niveau, []);
      groups.get(niveau).push(e);
    });

    // 3) Ordre des niveaux
    const LEVEL_ORDER = ['PS', 'MS', 'GS', 'CP', 'CE1', 'CE2', 'CM1', 'CM2'];
    const levelRank = (name) => {
      const i = LEVEL_ORDER.indexOf(String(name).toUpperCase());
      return i === -1 ? 999 : i;
    };

    const levels = Array.from(groups.keys()).sort((a, b) => {
      const ra = levelRank(a), rb = levelRank(b);
      return (ra - rb) || a.localeCompare(b, 'fr', { sensitivity: 'base' });
    });

    // 4) Construire les blocs de niveau
    levels.forEach(niveau => {
      const list = groups.get(niveau) || [];

      // Tri par prénom (accents/casse neutralisés)
      list.sort((a, b) =>
        (a.prenom || '').localeCompare(b.prenom || '', 'fr', { sensitivity: 'base' })
      );

      const bloc = document.createElement('div');
      bloc.className = 'pc_eleve_group';
      bloc.dataset.niveau = niveau;

      const head = document.createElement('div');
      head.className = 'pc_eleve_group_title';
      head.textContent = niveau;
      bloc.appendChild(head);

      const itemsWrap = document.createElement('div');
      itemsWrap.className = 'pc_eleve_group_list';

      list.forEach(e => {
        const item = document.createElement('div');
        item.className = 'pc_eleve_item';
        item.dataset.eleveId = e.id;
        item.draggable = false;

        const img = document.createElement('img');
        img.src = PHOTOS_BASE + (e.photo_filename || 'default.jpg');
        img.draggable = false;

        const name = document.createElement('div');
        name.className = 'name';

        const shortName = (e) => {
          const prenom = (e.prenom || '').trim();
          const nomInit = (e.nom || '').trim().charAt(0);
          return nomInit ? `${prenom} ${nomInit}.` : prenom;
        };
        name.textContent = shortName(e);

        item.title = `${(e.prenom || '').trim()} ${(e.nom || '').trim()}`.trim();

        item.append(img, name);
        item.addEventListener('pointerdown', startDragFromList);

        itemsWrap.appendChild(item);
      });

      bloc.appendChild(itemsWrap);
      $elist.appendChild(bloc);
    });
  }

  function buildWallMeasuresFor(w) {
    if (!$svg || !w.points || w.points.length < 2) return;
    for (let i = 0; i < w.points.length - 1; i++) {
      const a = w.points[i], b = w.points[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const du = Math.hypot(dx, dy);
      if (du < 1e-6) continue;

      const midxU = (a.x + b.x) / 2, midyU = (a.y + b.y) / 2;
      const { xpx, ypx, angDeg } = computeWallLabelPlacement(dx, dy, midxU, midyU);

      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('class', 'wall-measure');
      t.dataset.wallId = String(w.id);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      t.style.pointerEvents = 'none';
      t.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      t.style.fontSize = `${Math.max(11, unitPx * 0.45)}px`;
      t.style.fontWeight = '700';
      t.style.paintOrder = 'stroke';
      t.style.stroke = '#ffffff';
      t.style.strokeWidth = '3';
      t.style.strokeLinejoin = 'round';
      t.style.fill = '#111827';
      t.textContent = formatLen(du);
      t.setAttribute('x', String(xpx));
      t.setAttribute('y', String(ypx));
      t.setAttribute('transform', `rotate(${angDeg}, ${xpx}, ${ypx})`);
      $svg.appendChild(t);
    }
  }

  function hideWallMeasures(wallId) {
    $svg?.querySelectorAll(`.wall-measure[data-wall-id="${wallId}"]`).forEach(n => n.remove());
  }

  function updateVisibleWallMeasures() {
    if (!$svg) return;
    const ids = [...new Set(Array.from($svg.querySelectorAll('.wall-measure'))
      .map(n => n.dataset.wallId))];

    ids.forEach(id => {
      hideWallMeasures(id);
      const w = state.walls.find(W => String(W.id) === String(id));
      if (w) buildWallMeasuresFor(w);
    });
  }

  function renderWalls() {
    if (!$svg) return;
    dedupeWallsInState();
    ensureHatchPattern();

    $svg.querySelectorAll('.wall, .wall-draft, .wall-preview, .wall-measure, .wall-angle').forEach(n => n.remove());

    for (const w of (state.walls || [])) {
      if (!w.points || w.points.length < 2) continue;

      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.classList.add('wall');
      poly.dataset.wallId = String(w.id);
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', 'url(#hatch)');
      poly.setAttribute('stroke-width', Math.max(3, unitPx * 0.12));
      poly.style.pointerEvents = 'stroke';
      poly.addEventListener('click', handleSelectableClick);
      poly.addEventListener('mouseenter', () => {
        const id = String(w.id);
        if (!$svg?.querySelector(`.wall-measure[data-wall-id="${id}"]`)) buildWallMeasuresFor(w);
        if (!$svg?.querySelector(`.wall-angle[data-wall-id="${id}"]`)) buildWallAnglesFor(w);
      });
      poly.addEventListener('mouseleave', () => {
        if (!selection.has(poly)) hideWallMeasures(String(w.id));
        if (!selection.has(poly)) hideWallAngles(String(w.id));
      });
      const pts = w.points.map(p => `${toPx(p.x)},${toPx(p.y)}`).join(' ');
      poly.setAttribute('points', pts);
      $svg.appendChild(poly);
    }
  }

  function updateWallMeasures() {
    updateVisibleWallMeasures();
    updateVisibleWallAngles();
  }

  function ensureFurnitureMeasureNodes(el) {
    const mk = (cls) => {
      const d = document.createElement('div');
      d.className = `furn-measure ${cls}`;
      d.style.position = 'absolute';
      d.style.left = '50%';
      d.style.top = '50%';
      d.style.transformOrigin = 'center center';
      d.style.pointerEvents = 'none';
      d.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      d.style.fontWeight = '700';
      d.style.borderRadius = '8px';
      d.style.padding = '1px 4px';
      d.style.background = 'rgba(255,255,255,.92)';
      d.style.border = '1px solid rgba(0,0,0,.08)';
      d.style.color = '#111827';
      d.style.boxShadow = '0 0 0 2px rgba(255,255,255,.55)';
      d.style.userSelect = 'none';
      return d;
    };
    const pick = (cls) => el.querySelector(`.furn-measure.${cls}`) || el.appendChild(mk(cls));

    const topLab = pick('fm-top');
    const rightLab = pick('fm-right');
    const bottomLab = pick('fm-bottom');
    const leftLab = pick('fm-left');
    const diamLab = pick('fm-diam');

    return { topLab, rightLab, bottomLab, leftLab, diamLab };
  }

  function showFurnitureMeasures(el) {
    const { topLab, rightLab, bottomLab, leftLab, diamLab } = ensureFurnitureMeasureNodes(el);

    // Tout masquer puis base commune
    [topLab, rightLab, bottomLab, leftLab, diamLab].forEach(n => {
      n.style.display = 'none';
      n.style.position = 'absolute';
      n.style.left = '50%';
      n.style.top = '50%';
      n.style.transformOrigin = 'center center';
      n.style.pointerEvents = 'none';
    });

    // Dimensions LOCALES (valeurs style, AVANT rotation)
    const Wpx = parseFloat(el.style.width || '0') || 0;   // axe X local
    const Hpx = parseFloat(el.style.height || '0') || 0;   // axe Y local

    if (Wpx < 24 || Hpx < 24) return; // trop petit → pas d’étiquettes

    // Unités “locales”
    const wUnits = Wpx / unitPx;
    const hUnits = Hpx / unitPx;

    // Apparence : police plus petite + léger retrait depuis le bord
    const fsPx = Math.max(8, Math.min(12, unitPx * 0.18));
    const inset = Math.max(4, unitPx * 0.12);

    // Coins arrondis → longueurs droites visibles
    const id = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
    const f = Number.isFinite(id) ? state.furniture.find(x => x.id === id) : null;
    const rUnits = f ? cornerUnitsFor(f) : 0;
    const showW = f?.radius ? Math.max(0, wUnits - 2 * rUnits) : wUnits;
    const showH = f?.radius ? Math.max(0, hUnits - 2 * rUnits) : hUnits;

    const type = (el.dataset.furnitureType || '').toLowerCase();

    const showAs = (node, txt) => {
      node.style.display = '';
      node.style.fontSize = fsPx + 'px';
      node.textContent = txt;
    };

    // Tables rondes → Ø centré
    if (type === 'table_round') {
      showAs(diamLab, 'Ø ' + formatLen(Math.min(wUnits, hUnits)));
      diamLab.style.transform = 'translate(-50%, -50%)';
      return;
    }

    // Rectangles (coins carrés/arrondis) : 4 côtés
    // IMPORTANT : on calcule les décalages dans le REPÈRE LOCAL du meuble.
    // L’élément parent est déjà rotaté, donc ces positions collent toujours aux bords.

    // Haut / Bas (aucune rotation du label)
    showAs(topLab, formatLen(showW));
    topLab.style.transform =
      `translate(-50%, -50%) translate(0, ${-(Hpx / 2 - inset)}px)`;

    showAs(bottomLab, formatLen(showW));
    bottomLab.style.transform =
      `translate(-50%, -50%) translate(0, ${(Hpx / 2 - inset)}px)`;

    // Gauche / Droite (label vertical)
    showAs(leftLab, formatLen(showH));
    leftLab.style.transform =
      `translate(-50%, -50%) translate(${-(Wpx / 2 - inset)}px, 0) rotate(90deg)`;

    showAs(rightLab, formatLen(showH));
    rightLab.style.transform =
      `translate(-50%, -50%) translate(${(Wpx / 2 - inset)}px, 0) rotate(90deg)`;
  }





  function updateFurnitureMeasures(el) {
    const any = el.querySelector('.furn-measure');
    if (!any || (any.style.display === 'none')) return;
    showFurnitureMeasures(el);
  }

  function hideFurnitureMeasures(el) {
    el.querySelectorAll('.furn-measure').forEach(n => n.style.display = 'none');
  }

  function render() {
    const snap = selectionSnapshot();

    renderPlansSelect();
    clearStage();
    fitStageToWrap();

    const posById = {}; for (const p of state.positions) posById[p.eleve_id] = p;
    for (const e of state.eleves) { const pos = posById[e.id]; if (pos) addCard(e, pos); }
    renderFurniture();
    renderWalls();
    renderEleveList();
    ensureFurniturePalette();
    refreshFurnitureEditability();

    restoreSelectionFromSnapshot(snap);
    refreshToolbarActionsEnabled();
  }

  // palette
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

    function el(tag, className, attrs) {
      const n = document.createElement(tag);
      if (className) n.className = className;
      if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }

    $palette.innerHTML = '';

    // Outil Mur (tracer)
    (function buildWallTool() {
      const item = el('div', 'pc_furn_tpl wall_tool');
      const thumb = el('div', 'thumb');
      thumb.style.height = '12px';
      thumb.style.borderRadius = '6px';
      thumb.style.background = '#111827';
      const info = el('div', 'info');
      const name = el('div', 'name'); name.textContent = 'Mur (tracer)';
      const dims = el('div', 'dims'); dims.textContent = 'clics successifs – Entrée pour finir';
      info.append(name, dims);
      item.append(thumb, info);
      item.style.cursor = 'pointer';

      item.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        startWallTool(ev);
      });

      $palette.appendChild(item);
    })();

    // Items meubles
    FURN_DEFS.forEach((def) => {
      const item = el('div', 'pc_furn_tpl');
      item.style.cursor = 'grab';

      const baseColor = (FURN_COLORS[def.type] || FURN_DEF_COLORS[def.type] || '#ffffff');

      const thumb = el('div', 'thumb' + (def.type === 'table_round' ? ' round' : ''));
      thumb.style.background = baseColor;
      thumb.style.borderColor = baseColor;

      const info = el('div', 'info');
      const name = el('div', 'name'); name.textContent = def.label || def.type;
      const dims = el('div', 'dims'); dims.textContent = `${def.w}×${def.h}`;
      info.append(name, dims);

      const cp = el('input', '');
      cp.type = 'color';
      cp.value = baseColor;
      cp.title = `Couleur ${def.label || def.type}`;
      ['pointerdown', 'mousedown', 'click'].forEach(evt =>
        cp.addEventListener(evt, (e) => { e.stopPropagation(); })
      );
      cp.addEventListener('input', () => {
        FURN_COLORS[def.type] = cp.value;
        thumb.style.background = cp.value;
        thumb.style.borderColor = cp.value;
      });

      const onPointerDown = (ev) => { if (ev.target === cp) return; startCreateFurnitureDrag(ev, def); };
      item.addEventListener('pointerdown', onPointerDown);

      item.append(thumb, info, cp);
      $palette.appendChild(item);
    });

    $palette.dataset.built = '1';
  }

  function dedupeWallsInState() {
    const seen = new Set();
    state.walls = state.walls.filter(w => {
      const key = String(w.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // [7] ----------------------------------------------------------------------
  // DRAG & DROP
  // -------------------------------------------------------------------------

  // 7.1 Élève depuis la liste (ghost final)
  let dragGhost = null;
  let dragData = null;

  function startDragFromList(ev) {
    ev.preventDefault();
    const eleveId = parseInt(ev.currentTarget.dataset.eleveId, 10);
    const eleve = state.eleves.find(e => e.id === eleveId);
    if (!eleve) return;

    dragData = { kind: 'fromList', eleveId };
    let hasDrag = false; const sx = ev.clientX, sy = ev.clientY;

    const ensureGhost = () => {
      if (dragGhost) return;
      dragGhost = makeStudentGhost(eleve);
      document.body.appendChild(dragGhost);
    };
    const onMove = e => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!hasDrag && Math.hypot(dx, dy) > DRAG_THRESHOLD) { hasDrag = true; ensureGhost(); }
      if (hasDrag && dragGhost) { dragGhost.style.left = (e.clientX + 5) + 'px'; dragGhost.style.top = (e.clientY + 5) + 'px'; }
    };
    const onUp = e => {
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

  // conversion client → unités clampées + prise en compte w/h effectifs (swap)
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

  // 7.2 Déplacement carte élève
  function startDragCard(ev) {
    if (ev.target.closest('.pc_delete_btn') || ev.target.closest('.pc_rot_btn')) return;
    ev.preventDefault();
    const card = ev.currentTarget;
    isDraggingNow = true;

    dragData = {
      kind: 'card',
      eleveId: parseInt(card.dataset.eleveId, 10),
      startLeft: parseFloat(card.style.left || '0'),
      startTop: parseFloat(card.style.top || '0'),
      sx: ev.clientX, sy: ev.clientY,
      moved: false
    };
    card.setPointerCapture(ev.pointerId);
    card.addEventListener('pointermove', onDragCardMove);
    card.addEventListener('pointerup', endDragCard, { once: true });
  }
  function onDragCardMove(ev) {
    const card = ev.currentTarget;
    const dx = ev.clientX - dragData.sx;
    const dy = ev.clientY - dragData.sy;
    if (!dragData.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) dragData.moved = true;
    if (selection.has(card)) {
      selection.forEach(node => {
        const sL = parseFloat(node.dataset._startL || node.style.left || '0');
        const sT = parseFloat(node.dataset._startT || node.style.top || '0');
        node.style.left = (sL + dx) + 'px';
        node.style.top = (sT + dy) + 'px';
      });
    } else {
      card.style.left = (dragData.startLeft + dx) + 'px';
      card.style.top = (dragData.startTop + dy) + 'px';
    }
  }

  function endDragCard(ev) {
    const card = ev.currentTarget;
    card.releasePointerCapture(ev.pointerId);
    card.removeEventListener('pointermove', onDragCardMove);

    if (!dragData || !dragData.moved) {
      if (pendingShiftDeselect && pendingShiftDeselect === card) {
        if (selection.has(card)) selection.delete(card);
        else selection.add(card);
        refreshSelectionStyling();
      }
      pendingShiftDeselect = null;
      dragData = null;
      isDraggingNow = false;
      return;
    }

    pendingShiftDeselect = null;
    nudgeSelection(0, 0); // commit
    dragData = null;
    isDraggingNow = false;
    render();
  }

  // snap à un mur le plus proche (projection sur segments)
  function snapToNearestWall(x, y, maxDist = 0.6) {
    if (!Array.isArray(state.walls) || !state.walls.length) return null;

    let best = null;
    const pt = { x, y };
    const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };
    const clamp01 = t => Math.max(0, Math.min(1, t));

    for (const w of state.walls) {
      const pts = (w.points || []);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const vx = b.x - a.x, vy = b.y - a.y;
        const len2 = vx * vx + vy * vy || 1e-9;
        const t = clamp01(((pt.x - a.x) * vx + (pt.y - a.y) * vy) / len2);
        const proj = { x: a.x + t * vx, y: a.y + t * vy };
        const d2 = dist2(pt, proj);
        if (!best || d2 < best.d2) best = { d2, p: proj, seg: { a, b } };
      }
    }
    if (!best) return null;
    if (Math.sqrt(best.d2) > maxDist) return null;
    const dx = best.seg.b.x - best.seg.a.x, dy = best.seg.b.y - best.seg.a.y;
    const angDeg = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    return { point: best.p, angleDeg: angDeg };
  }

  // 7.3 Création meuble depuis palette (ghost final)
  function startCreateFurnitureDrag(ev, def) {
    ev.preventDefault();
    let hasDrag = false; const sx = ev.clientX, sy = ev.clientY;

    const ensureGhost = () => {
      if (dragGhost) return;
      const rotAbs = 0, swap = isQuarterTurnSwap(rotAbs);
      const wEff = swap ? def.h : def.w;
      const hEff = swap ? def.w : def.h;
      dragGhost = makeFurnitureGhost(def.type, wEff, hEff);
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
      if (!hasDrag) return;
      if (!isPointInStage(e.clientX, e.clientY)) return;

      const rotAbs = 0, swap = isQuarterTurnSwap(rotAbs);
      const wEff = swap ? def.h : def.w;
      const hEff = swap ? def.w : def.h;

      const isOnWallType = (def.type === 'door' || def.type === 'window');
      let drop = clientToUnitsClamped(e.clientX, e.clientY, wEff, hEff);
      if (isOnWallType && state.walls.length) {
        const s = snapToNearestWall(drop.x, drop.y);
        if (!s) { alert("Placez portes/fenêtres sur un mur."); return; }
        drop = { x: snapUnits(s.point.x - wEff / 2), y: snapUnits(s.point.y - hEff / 2) };
        def._initRotAbs = Math.round(s.angleDeg);
      }

      let spot = findNearestFreeSpot(drop.x, drop.y, wEff, hEff) || { x: drop.x, y: drop.y };
      spot = snapCollapse(spot, rectsInPlan({}));

      const col = FURN_COLORS[def.type] || FURN_DEF_COLORS[def.type] || '#fff';
      const uid = genUid();
      const tmpId = tempIdSeq--;

      state.furniture.push({
        id: tmpId, uid,
        type: def.type, label: def.label, color: col,
        x: spot.x, y: spot.y,
        w: def.w, h: def.h,
        rotation: def._initRotAbs || 0, rotAbs: def._initRotAbs || 0, z: 0,
        radius: false
      });

      autosaveFurniture();
      render();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  // 7.4 Déplacement / redimension meuble
  function startDragFurniture(ev) {
    if (ev.target.closest('.pc_delete_btn')) return;
    if (ev.target.classList.contains('rz')) return;
    ev.preventDefault();
    const el = ev.currentTarget;
    isDraggingNow = true; autosaveFurniture.cancel?.();

    dragData = {
      kind: 'furn',
      id: el.dataset.id ? parseInt(el.dataset.id, 10) : null,
      startLeft: parseFloat(el.style.left || '0'),
      startTop: parseFloat(el.style.top || '0'),
      sx: ev.clientX, sy: ev.clientY,
      moved: false
    };
    el.setPointerCapture(ev.pointerId);
    el.addEventListener('pointermove', onDragFurnitureMove);
    el.addEventListener('pointerup', endDragFurniture, { once: true });
  }
  function onDragFurnitureMove(ev) {
    const el = ev.currentTarget;
    const dx = ev.clientX - dragData.sx;
    const dy = ev.clientY - dragData.sy;
    if (!dragData.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) dragData.moved = true;

    if (selection.has(el)) {
      selection.forEach(node => {
        const sL = parseFloat(node.dataset._startL || node.style.left || '0');
        const sT = parseFloat(node.dataset._startT || node.style.top || '0');
        node.style.left = (sL + dx) + 'px';
        node.style.top = (sT + dy) + 'px';
      });
    } else {
      el.style.left = (dragData.startLeft + dx) + 'px';
      el.style.top = (dragData.startTop + dy) + 'px';
    }
  }

  // Fin de drag d'un meuble
  // Fin de drag d'un meuble — version cohérente avec startDragFurniture/dragData
  // Fin de drag d'un meuble — commit DOM -> state + autosave + resync
  function endDragFurniture(ev) {
    const el = ev.currentTarget;
    try { el.releasePointerCapture(ev.pointerId); } catch { }
    el.removeEventListener('pointermove', onDragFurnitureMove);

    // Pas de vrai déplacement : juste gérer le toggle Shift éventuel
    if (!dragData || !dragData.moved) {
      if (pendingShiftDeselect && pendingShiftDeselect === el) {
        if (selection.has(el)) selection.delete(el);
        else selection.add(el);
        refreshSelectionStyling();
      }
      pendingShiftDeselect = null;
      dragData = null;
      isDraggingNow = false;
      return;
    }

    // ----- lire position finale (px)
    const Lpx = parseFloat(el.style.left || '0') || 0;
    const Tpx = parseFloat(el.style.top || '0') || 0;
    const Wpx = parseFloat(el.style.width || '0') || 0;
    const Hpx = parseFloat(el.style.height || '0') || 0;

    // ----- px -> unités
    const wU = (typeof pxToUnits === 'function') ? pxToUnits(Wpx) : (Wpx / unitPx);
    const hU = (typeof pxToUnits === 'function') ? pxToUnits(Hpx) : (Hpx / unitPx);
    let gx = (typeof pxToUnits === 'function') ? pxToUnits(Lpx) : (Lpx / unitPx);
    let gy = (typeof pxToUnits === 'function') ? pxToUnits(Tpx) : (Tpx / unitPx);

    // snap grille
    if (typeof snapUnits === 'function') { gx = snapUnits(gx); gy = snapUnits(gy); }

    // rester dans la scène
    if (typeof clampToStage === 'function') {
      const c = clampToStage(gx, gy, wU, hU);
      gx = c.gx; gy = c.gy;
    }

    // aimantation/anti-collision
    if (typeof snapCollapse === 'function' && typeof rectsInPlan === 'function') {
      const meId = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
      const snapped = snapCollapse({ x: gx, y: gy, w: wU, h: hU }, rectsInPlan({ furnitureId: meId }));
      gx = snapped.x; gy = snapped.y;
    }

    // répercuter au DOM (px)
    el.style.left = (gx * unitPx) + 'px';
    el.style.top = (gy * unitPx) + 'px';

    // ----- mettre à jour le state
    const id = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
    if (id != null && Array.isArray(state?.furniture)) {
      const f = state.furniture.find(x => x.id === id);
      if (f) {
        f.x = gx; f.y = gy;
        if (typeof markFurnDirty === 'function') { try { markFurnDirty(f); } catch { } }
      }
    }

    // ----- sauvegarde unique + resync contrôlé
    try { autosaveFurniture?.(); } catch (e) { console.warn(e); }
    try { resyncSoon?.(0); } catch (e) { console.warn(e); }

    // cleanup
    pendingShiftDeselect = null;
    dragData = null;
    isDraggingNow = false;
  }




  // Helpers pour le resize ancré (repère local du meuble)
  function _anchorLocalForOppositeHandle(dir, W, H) {
    // dir = poignée saisie ; l’ancre = coin opposé
    const halfW = W / 2, halfH = H / 2;
    const d = (dir || 'se').toLowerCase();
    if (d === 'se') return { x: -halfW, y: -halfH }; // ancre = NW
    if (d === 'ne') return { x: -halfW, y: halfH }; // ancre = SW
    if (d === 'sw') return { x: halfW, y: -halfH }; // ancre = NE
  /* 'nw' */      return { x: halfW, y: halfH }; // ancre = SE
  }
  function _rot(ax, ay, cos, sin) {
    // (x,y) local -> monde
    return { x: ax * cos - ay * sin, y: ax * sin + ay * cos };
  }

  // --- Redimension
  function startResizeFurniture(ev) {
    const el = ev.currentTarget.parentElement;
    const handle = ev.currentTarget;

    const L = parseFloat(el.style.left || '0');
    const T = parseFloat(el.style.top || '0');
    const W = parseFloat(el.style.width || '0');
    const H = parseFloat(el.style.height || '0');
    const rotDeg = parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0;
    const dirLocal = (handle.dataset.dir || 'se').toLowerCase();

    const cx = L + W / 2, cy = T + H / 2; // centre (px)
    const rad = rotDeg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);

    // ancre monde = centre + R * (ancre locale)
    const A0loc = _anchorLocalForOppositeHandle(dirLocal, W, H);
    const A0off = _rot(A0loc.x, A0loc.y, cos, sin);
    const Ax = cx + A0off.x, Ay = cy + A0off.y;

    dragData = {
      kind: 'resize',
      id: el.dataset.id ? parseInt(el.dataset.id, 10) : null,
      dirLocal,
      // état initial
      startLeft: L, startTop: T, startW: W, startH: H,
      cx0: cx, cy0: cy,
      rotDeg, cos, sin,
      // ancre monde
      anchorX: Ax, anchorY: Ay,
      sx: ev.clientX, sy: ev.clientY
    };

    el.setPointerCapture(ev.pointerId);
    el.addEventListener('pointermove', onResizeFurnitureMove);
    el.addEventListener('pointerup', endResizeFurniture, { once: true });
    ev.stopPropagation();
  }

  function onResizeFurnitureMove(ev) {
    const el = ev.currentTarget;
    const dx = (ev.clientX - dragData.sx);
    const dy = (ev.clientY - dragData.sy);

    // projeter le déplacement curseur dans le repère local de l’objet
    const du = dx * dragData.cos + dy * dragData.sin;    // axe X local (largeur)
    const dv = -dx * dragData.sin + dy * dragData.cos;   // axe Y local (hauteur)

    // nouvelles dimensions (en px), selon la poignée utilisée
    let W = dragData.startW;
    let H = dragData.startH;
    if (dragData.dirLocal.includes('e')) W = dragData.startW + du;
    if (dragData.dirLocal.includes('w')) W = dragData.startW - du;
    if (dragData.dirLocal.includes('s')) H = dragData.startH + dv;
    if (dragData.dirLocal.includes('n')) H = dragData.startH - dv;

    W = Math.max(16, W);
    H = Math.max(16, H);

    // centre requis pour que le COIN OPPOSÉ reste fixe en monde
    const AnewLoc = _anchorLocalForOppositeHandle(dragData.dirLocal, W, H); // (±W/2, ±H/2)
    const AnewOff = _rot(AnewLoc.x, AnewLoc.y, dragData.cos, dragData.sin);
    const cx = dragData.anchorX - AnewOff.x;
    const cy = dragData.anchorY - AnewOff.y;

    // rectangle affiché (style) = boîte non-rotée centrée en (cx,cy)
    el.style.width = `${W}px`;
    el.style.height = `${H}px`;
    el.style.left = `${(cx - W / 2)}px`;
    el.style.top = `${(cy - H / 2)}px`;

    updateFurnitureMeasures(el);
  }

  function endResizeFurniture(ev) {
    const el = ev.currentTarget;
    el.releasePointerCapture(ev.pointerId);
    el.removeEventListener('pointermove', onResizeFurnitureMove);

    // on est en fin de resize : PAS de resnap/collision, juste clamp dans le stage
    const L = parseFloat(el.style.left || '0');
    const T = parseFloat(el.style.top || '0');
    const W = parseFloat(el.style.width || '0');
    const H = parseFloat(el.style.height || '0');

    // convertit px -> unités (en arrondissant aux ticks UI)
    const gw = Math.max(TICK, Math.ceil((W / unitPx) * UI_SUBDIV) / UI_SUBDIV);
    const gh = Math.max(TICK, Math.ceil((H / unitPx) * UI_SUBDIV) / UI_SUBDIV);

    const rotNow = parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0;

    // coin TL en px -> unités (en tenant compte de l'échange w/h à 90/270°)
    const box = stageInnerBox();
    const pxAdj = adjustClientPxForSwap(
      box.left + L, box.top + T, gw, gh, rotNow
    );

    // clamp simple au stage, pas de snap aux autres
    let { x: gx, y: gy } = clientToUnitsClamped(pxAdj.leftPx, pxAdj.topPx, pxAdj.wEff, pxAdj.hEff);

    // coin TL réel en unités (retire le décalage dû au swap)
    gx = snapUnits(gx - pxAdj.dx);
    gy = snapUnits(gy - pxAdj.dy);

    const id = parseInt(el.dataset.id || '-1', 10);
    const f = state.furniture.find(x => x.id === id);
    if (f) {
      f.w = gw; f.h = gh; f.x = gx; f.y = gy;
    }

    // sauvegarde meubles (debounce)
    autosaveFurniture();

    // mettre à jour l’affichage des mesures si on est encore hover
    updateFurnitureMeasures(el);
  }

  /* ============================================================================
     AutoWalls — Traçage automatique des murs (flèche orientable)
     - Flèche SVG draggable (position) + rotative (wheel) = orientation Mur 1
     - Clic dans le plan = crée/déplace la flèche
     - Drag&drop d’un jeton #aw_handle_token si présent (optionnel)
     - Saisie Mur N (cm) + Angle N (°), illimité — Angle N appliqué APRÈS le segment N
     - Calcul en UNITÉS (CM_PER_UNIT) puis insertion dans state.walls + render + save
     ============================================================================ */
  /* ============================================================================
    AutoWalls — Traçage automatique des murs (flèche orientable)
    ============================================================================ */
  const AutoWalls = (() => {
    // ===== ÉTAT =====
    let gPos = null;                 // <g id="aw_start_handle"> (translate)
    let startPos = null;             // {x,y} px (coords SVG)
    let startDirDeg = 0;             // orientation (0° = →)
    let dragging = false;
    let dragOffset = { x: 0, y: 0 };

    const DEG2RAD = Math.PI / 180;
    const gridSize = (window.SEATING_CONF && +window.SEATING_CONF.grid) ? +window.SEATING_CONF.grid : 0;

    // ===== SVG / SCÈNE =====
    function getSvgLayer() {
      return document.querySelector('#pc_svg, #pc_walls_layer, #pc_stage_svg, svg');
    }
    function ensureClickSurface(svg) {
      const ns = 'http://www.w3.org/2000/svg';
      let r = svg.querySelector('rect.pc-click-surface');
      if (!r) {
        r = document.createElementNS(ns, 'rect');
        r.classList.add('pc-click-surface');
        r.setAttribute('x', 0);
        r.setAttribute('y', 0);
        r.setAttribute('width', '100%');
        r.setAttribute('height', '100%');
        r.setAttribute('fill', 'transparent');
        r.setAttribute('pointer-events', 'all');
        svg.insertBefore(r, svg.firstChild);
      }
    }
    function screenToSvg(svg, clientX, clientY, fallbackEvt) {
      const pt = svg.createSVGPoint();
      pt.x = clientX; pt.y = clientY;
      const ctm = svg.getScreenCTM?.();
      return ctm ? pt.matrixTransform(ctm.inverse())
        : { x: fallbackEvt?.offsetX || 0, y: fallbackEvt?.offsetY || 0 };
    }
    function snap(v) {
      if (!gridSize) return v;
      return Math.round(v / gridSize) * gridSize;
    }
    function setDisplay(x, y) {
      const el = document.getElementById('aw_start_display');
      if (!el) return;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const a = ((startDirDeg % 360) + 360) % 360;
        el.textContent = `Départ : (${Math.round(x)}, ${Math.round(y)}) – ${Math.round(a)}°`;
      } else {
        el.textContent = 'Aucun point choisi';
      }
    }

    // ===== UNITÉS =====
    function cmToUnits(cm) {
      if (typeof CM_PER_UNIT === 'number' && CM_PER_UNIT > 0) return cm / CM_PER_UNIT;
      return cm; // fallback : 1 unité = 1 cm
    }
    function pxToUnits(px) {
      if (typeof unitPx === 'number' && unitPx > 0) return px / unitPx;
      // fallback : 10 px = 1 cm
      const cm = px / 10;
      return cmToUnits(cm);
    }

    // ===== LIGNES UI =====
    function makeRow(i) {
      const row = document.createElement('div');
      row.className = 'aw-row';
      row.innerHTML = `
      <div class="aw-cell">
        <label for="aw_len_${i}">Mur ${i} (cm)</label>
        <input type="number" id="aw_len_${i}" class="aw-len" min="0" step="1" placeholder="ex. 300">
      </div>
      <div class="aw-cell">
        <label for="aw_ang_${i}">Angle ${i} (°)</label>
        <input type="number" id="aw_ang_${i}" class="aw-ang" step="1" placeholder="ex. 90">
      </div>
      <button type="button" class="aw-del" title="Supprimer cette ligne">×</button>
    `;
      return row;
    }
    function addRow(autofocus = true) {
      const box = document.getElementById('aw_rows');
      const i = box.querySelectorAll('.aw-row').length + 1;
      const row = makeRow(i);
      box.appendChild(row);

      const lenEl = row.querySelector('.aw-len');
      const angEl = row.querySelector('.aw-ang');
      const onChange = () => {
        if (lenEl.value && angEl.value && row === box.lastElementChild) addRow(false);
      };
      lenEl.addEventListener('input', onChange);
      angEl.addEventListener('input', onChange);

      row.querySelector('.aw-del').addEventListener('click', () => { row.remove(); renumberRows(); });
      if (autofocus) lenEl.focus();
    }
    function renumberRows() {
      [...document.querySelectorAll('#aw_rows .aw-row')].forEach((r, i) => {
        const idx = i + 1;
        r.querySelector('.aw-len').id = `aw_len_${idx}`;
        r.querySelector('.aw-ang').id = `aw_ang_${idx}`;
        r.querySelector(`label[for^="aw_len_"]`).setAttribute('for', `aw_len_${idx}`);
        r.querySelector(`label[for^="aw_ang_"]`).setAttribute('for', `aw_ang_${idx}`);
        r.querySelector(`label[for="aw_len_${idx}"]`).textContent = `Mur ${idx} (cm)`;
        r.querySelector(`label[for="aw_ang_${idx}"]`).textContent = `Angle ${idx} (°)`;
      });
    }
    function readSegments() {
      const segs = [];
      for (const r of document.querySelectorAll('#aw_rows .aw-row')) {
        const len = parseFloat(r.querySelector('.aw-len')?.value || '');
        const ang = parseFloat(r.querySelector('.aw-ang')?.value || '');
        if (Number.isFinite(len) && len > 0) segs.push({ length_cm: len, turn_deg: Number.isFinite(ang) ? ang : 0 });
      }
      return segs;
    }

    // ===== FLÈCHE ORIENTABLE =====
    function ensureArrowHead(svg) {
      const ns = 'http://www.w3.org/2000/svg';
      let defs = svg.querySelector('defs');
      if (!defs) { defs = document.createElementNS(ns, 'defs'); svg.insertBefore(defs, svg.firstChild); }
      let m = defs.querySelector('#aw_arrow_head');
      if (!m) {
        m = document.createElementNS(ns, 'marker');
        m.setAttribute('id', 'aw_arrow_head');
        m.setAttribute('markerWidth', '10');
        m.setAttribute('markerHeight', '10');
        m.setAttribute('refX', '10');
        m.setAttribute('refY', '5');
        m.setAttribute('orient', 'auto-start-reverse');
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M0,0 L10,5 L0,10 Z');
        path.setAttribute('fill', '#e11d48');
        m.appendChild(path);
        defs.appendChild(m);
      }
    }
    function createStartHandle(svg, x, y) {
      const ns = 'http://www.w3.org/2000/svg';
      ensureArrowHead(svg);

      gPos = document.createElementNS(ns, 'g');
      gPos.setAttribute('id', 'aw_start_handle');
      gPos.style.pointerEvents = 'all';
      gPos.setAttribute('cursor', 'grab');

      const gDir = document.createElementNS(ns, 'g');
      gDir.classList.add('aw-dir'); // transform-origin: 0 0;

      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('y1', '0');
      line.setAttribute('x2', '28'); line.setAttribute('y2', '0');
      line.setAttribute('stroke', '#e11d48'); line.setAttribute('stroke-width', '3');
      line.setAttribute('marker-end', 'url(#aw_arrow_head)');

      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('r', '5'); dot.setAttribute('cx', '0'); dot.setAttribute('cy', '0');
      dot.setAttribute('fill', '#e11d48'); dot.setAttribute('stroke', '#fff'); dot.setAttribute('stroke-width', '2');

      gDir.appendChild(line);
      gDir.appendChild(dot);
      gPos.appendChild(gDir);
      svg.appendChild(gPos);

      moveHandle(x, y);
      setHandleDir(0);
      bindHandleInteractions(gPos, gDir, svg);
      return gPos;
    }
    function moveHandle(x, y) {
      if (!gPos) return;
      gPos.setAttribute('transform', `translate(${x}, ${y})`);
      startPos = { x, y };
      setDisplay(x, y);
    }
    function setHandleDir(deg) {
      startDirDeg = deg;
      gPos?.querySelector('.aw-dir')?.setAttribute('transform', `rotate(${deg})`);
      if (startPos) setDisplay(startPos.x, startPos.y);
    }
    function bindHandleInteractions(g, gDir, svg) {
      g.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        g.setPointerCapture?.(e.pointerId);
        g.setAttribute('cursor', 'grabbing');
        dragging = true;
        const p = screenToSvg(svg, e.clientX, e.clientY, e);
        dragOffset.x = p.x - startPos.x;
        dragOffset.y = p.y - startPos.y;
      });
      window.addEventListener('pointermove', (e) => {
        if (!dragging || !gPos) return;
        const p = screenToSvg(svg, e.clientX, e.clientY, e);
        let nx = p.x - dragOffset.x;
        let ny = p.y - dragOffset.y;
        if (gridSize && !e.altKey) { nx = snap(nx); ny = snap(ny); }
        moveHandle(nx, ny);
      });
      window.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        g.releasePointerCapture?.(e.pointerId);
        g.setAttribute('cursor', 'grab');
      });
      g.addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = e.altKey ? 1 : 15;
        const delta = (e.deltaY > 0 ? step : -step);
        setHandleDir((startDirDeg + delta) % 360);
      }, { passive: false });
    }

    // ===== CONSTRUCTION CHEMIN (UNITÉS) =====
    function getAngleMode() {
      // 'interior' (par défaut), 'turn' (rotation), 'absolute' (azimut)
      const sel = document.getElementById('aw_angle_mode');
      return sel?.value || 'interior';
    }
    function buildPointsUnits() {
      if (!startPos) { alert('Clique/dépose d’abord le point de départ.'); return null; }
      const segs = readSegments();
      if (!segs.length) { alert('Ajoute au moins un segment.'); return null; }

      const close = document.getElementById('aw_close')?.checked ?? true;
      const mode = getAngleMode();

      // départ en unités
      const pts = [{ x: pxToUnits(startPos.x), y: pxToUnits(startPos.y) }];
      let dirDeg = startDirDeg || 0; // orientation initiale = flèche

      segs.forEach((s) => {
        const L = cmToUnits(s.length_cm);
        const last = pts[pts.length - 1];
        const nx = last.x + Math.cos(dirDeg * DEG2RAD) * L;
        const ny = last.y + Math.sin(dirDeg * DEG2RAD) * L;
        pts.push({ x: nx, y: ny });

        // Appliquer l’angle pour orienter le segment suivant
        let applied;
        if (mode === 'interior') {
          // angle intérieur -> rotation externe (sens positif = horaire)
          applied = 180 - s.turn_deg;          // ex: intérieur 140° => +40°
        } else if (mode === 'absolute') {
          // orientation absolue visée (azimut) pour le prochain segment
          applied = (s.turn_deg - dirDeg);
        } else { // 'turn' (rotation pure)
          applied = s.turn_deg;
        }
        dirDeg = (dirDeg + applied) % 360;
      });

      if (close) {
        const a = pts[0], b = pts[pts.length - 1];
        if (a.x !== b.x || a.y !== b.y) pts.push({ x: a.x, y: a.y });
      }
      return pts;
    }

    // ===== PERSIST/RENDER =====
    async function validate() {
      const pts = buildPointsUnits();
      if (!pts?.length) return;

      try {
        const id = (typeof genUid === 'function') ? genUid() : `w_${Date.now().toString(36)}`;
        (window.state || (window.state = {}));
        state.walls || (state.walls = []);
        state.walls.push({ id, points: pts });

        if (typeof dedupeWallsInState === 'function') dedupeWallsInState();
        if (typeof renderWalls === 'function') renderWalls();
        if (typeof updateWallMeasures === 'function') updateWallMeasures();

        const planId = (typeof currentPlanIdSafe === 'function') ? currentPlanIdSafe() : null;
        if (planId != null && window.api?.saveWalls && typeof encodeWallsForStorage === 'function') {
          const payloadWalls = encodeWallsForStorage(state.walls);
          await api.saveWalls(planId, payloadWalls);
          try { localStorage.setItem(`pc_walls_${planId}`, JSON.stringify(payloadWalls)); } catch { }
        }
      } catch (e) {
        console.warn('[AutoWalls] save/render walls error:', e);
      }
    }
    function clearAll() {
      const box = document.getElementById('aw_rows');
      if (box) { box.innerHTML = ''; addRow(); addRow(false); }
      if (gPos && gPos.parentNode) gPos.parentNode.removeChild(gPos);
      gPos = null;
      startPos = null;
      startDirDeg = 0;
      setDisplay(NaN, NaN);
    }

    // ===== INTERACTIONS SCÈNE =====
    function bindPlanClick() {
      const svg = getSvgLayer();
      if (!svg) return;
      ensureClickSurface(svg);
      svg.addEventListener('click', (e) => {
        if (dragging) return;
        const p = screenToSvg(svg, e.clientX, e.clientY, e);
        let x = p.x, y = p.y;
        if (gridSize) { x = snap(x); y = snap(y); }
        if (!gPos) createStartHandle(svg, x, y);
        else moveHandle(x, y);
      });
    }
    // Jeton optionnel #aw_handle_token
    function bindTokenDragDrop() {
      const token = document.getElementById('aw_handle_token');
      const svg = getSvgLayer();
      if (!token || !svg) return;
      ensureClickSurface(svg);

      svg.addEventListener('dragover', (e) => { e.preventDefault(); });
      svg.addEventListener('drop', (e) => {
        e.preventDefault();
        const p = screenToSvg(svg, e.clientX, e.clientY, e);
        let x = p.x, y = p.y;
        if (gridSize) { x = snap(x); y = snap(y); }
        if (!gPos) createStartHandle(svg, x, y);
        else moveHandle(x, y);
      });
      token.addEventListener('dragstart', (e) => { try { e.dataTransfer.setData('text/plain', 'aw-handle'); } catch { } });
      token.addEventListener('click', () => {
        const rect = (document.getElementById('pc_stage') || svg).getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        const p = screenToSvg(svg, cx, cy);
        if (!gPos) createStartHandle(svg, p.x, p.y);
        else moveHandle(p.x, p.y);
      });
    }

    // ===== INIT =====
    function init() {
      addRow(); addRow(false);
      document.getElementById('aw_add_row')?.addEventListener('click', () => addRow(true));
      document.getElementById('aw_validate')?.addEventListener('click', validate);
      document.getElementById('aw_clear')?.addEventListener('click', clearAll);
      bindPlanClick();
      bindTokenDragDrop();
    }

    return { init };
  })();

  document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('pc_auto_walls')) AutoWalls.init();
    // 1) Activer la surveillance de la sélection
    bindSelectionBarHooks();
    updateAlignBarVisibility();

    // 2) Wiring des boutons
    document.getElementById('btn_align_left')?.addEventListener('click', () => alignSelection('left'));
    document.getElementById('btn_align_right')?.addEventListener('click', () => alignSelection('right'));
    document.getElementById('btn_align_top')?.addEventListener('click', () => alignSelection('top'));
    document.getElementById('btn_align_bottom')?.addEventListener('click', () => alignSelection('bottom'));
    document.getElementById('btn_dist_h')?.addEventListener('click', () => distributeSelection('h'));
    document.getElementById('btn_dist_v')?.addEventListener('click', () => distributeSelection('v'));
  });




  //////////////////////////////////////////////////////////////
  //////////////////////////////////////////////////////////////

  // 7.5 Tracé des murs (SVG) — live length + live angle + verrou 90° (Maj)
  function startWallTool(ev) {
    ev?.preventDefault?.();
    if (document.body.classList.contains('pc_wall_mode')) return;
    if (!$svg || !$stage || !state.active_plan) return;

    $svg.querySelectorAll('.wall-draft, .wall-preview, .wall-length, .wall-angle-live').forEach(n => n.remove());

    const planId = state.active_plan.id;
    let currentWall = { id: genUid(), points: [] };

    const progress = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    progress.classList.add('wall-draft');
    progress.setAttribute('fill', 'none');
    progress.setAttribute('stroke', 'url(#hatch)');
    progress.setAttribute('stroke-width', Math.max(3, unitPx * 0.12));
    progress.style.pointerEvents = 'none';
    $svg.appendChild(progress);

    const preview = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    preview.classList.add('wall-preview');
    preview.setAttribute('fill', 'none');
    preview.setAttribute('stroke', '#60a5fa');
    preview.setAttribute('stroke-width', Math.max(2, unitPx * 0.10));
    preview.setAttribute('stroke-dasharray', '6 4');
    preview.style.pointerEvents = 'none';
    $svg.appendChild(preview);

    const lenText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    lenText.setAttribute('class', 'wall-length');
    lenText.setAttribute('text-anchor', 'middle');
    lenText.setAttribute('dominant-baseline', 'central');
    lenText.style.pointerEvents = 'none';
    lenText.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    lenText.style.fontSize = `${Math.max(11, unitPx * 0.45)}px`;
    lenText.style.fontWeight = '700';
    lenText.style.paintOrder = 'stroke';
    lenText.style.stroke = '#ffffff';
    lenText.style.strokeWidth = '3';
    lenText.style.strokeLinejoin = 'round';
    lenText.style.fill = '#111827';
    $svg.appendChild(lenText);

    const angText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    angText.setAttribute('class', 'wall-angle-live');
    angText.setAttribute('text-anchor', 'middle');
    angText.setAttribute('dominant-baseline', 'central');
    angText.style.pointerEvents = 'none';
    angText.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    angText.style.fontSize = `${Math.max(11, unitPx * 0.45)}px`;
    angText.style.fontWeight = '700';
    angText.style.paintOrder = 'stroke';
    angText.style.stroke = '#ffffff';
    angText.style.strokeWidth = '3';
    angText.style.strokeLinejoin = 'round';
    angText.style.fill = '#111827';
    $svg.appendChild(angText);

    $stage.style.cursor = 'crosshair';
    document.body.classList.add('pc_wall_mode');

    const box = stageInnerBox();
    const ptToUnits = (cx, cy) => ({
      x: snapUnits((cx - box.left) / unitPx),
      y: snapUnits((cy - box.top) / unitPx),
    });

    let shiftDown = false;
    let lastMoveX = null, lastMoveY = null;

    function constrainWithShift(prev, last, raw) {
      if (prev) {
        let vx = last.x - prev.x, vy = last.y - prev.y;
        const n = Math.hypot(vx, vy);
        if (n > EPS) {
          vx /= n; vy /= n;
          const nx = -vy, ny = vx; // normale au segment précédent
          const tx = raw.x - last.x, ty = raw.y - last.y;
          const s = (tx * nx + ty * ny);
          return { x: snapUnits(last.x + nx * s), y: snapUnits(last.y + ny * s) };
        }
      }
      const dx = raw.x - last.x, dy = raw.y - last.y;
      if (Math.abs(dx) >= Math.abs(dy)) return { x: snapUnits(raw.x), y: snapUnits(last.y) };
      return { x: snapUnits(last.x), y: snapUnits(raw.y) };
    }

    const updateProgress = () => {
      if (currentWall.points.length < 2) { progress.setAttribute('points', ''); return; }
      const pts = currentWall.points.map(p => `${toPx(p.x)},${toPx(p.y)}`).join(' ');
      progress.setAttribute('points', pts);
    };

    function updatePreview(clientX, clientY, wantShift = false) {
      if (!currentWall.points.length) {
        preview.setAttribute('points', '');
        lenText.textContent = '';
        angText.textContent = '';
        return;
      }
      const last = currentWall.points[currentWall.points.length - 1];
      const raw = ptToUnits(clientX, clientY);
      const prev = currentWall.points.length >= 2 ? currentWall.points[currentWall.points.length - 2] : null;
      const cur = wantShift ? constrainWithShift(prev, last, raw) : raw;

      preview.setAttribute('points', [last, cur].map(p => `${toPx(p.x)},${toPx(p.y)}`).join(' '));

      const dx = cur.x - last.x, dy = cur.y - last.y;
      const du = Math.hypot(dx, dy);
      if (du < 1e-6) { lenText.textContent = ''; angText.textContent = ''; return; }

      const midxU = (last.x + cur.x) / 2, midyU = (last.y + cur.y) / 2;
      const { xpx, ypx, angDeg } = computeWallLabelPlacement(dx, dy, midxU, midyU);

      lenText.textContent = formatLen(du);
      lenText.setAttribute('x', String(xpx));
      lenText.setAttribute('y', String(ypx));
      lenText.setAttribute('transform', `rotate(${angDeg}, ${xpx}, ${ypx})`);

      if (prev) {
        const ang = computeAngleDeg(prev, last, cur);
        if (ang != null) {
          let u1x = prev.x - last.x, u1y = prev.y - last.y;
          let u2x = cur.x - last.x, u2y = cur.y - last.y;
          const n1 = Math.hypot(u1x, u1y) || 1, n2 = Math.hypot(u2x, u2y) || 1;
          u1x /= n1; u1y /= n1; u2x /= n2; u2y /= n2;
          let bx = u1x + u2x, by = u1y + u2y;
          let bl = Math.hypot(bx, by);
          if (bl < 1e-6) { bx = -u2y; by = u2x; bl = 1; }
          bx /= bl; by /= bl;

          const rPx = Math.max(12, unitPx * 0.6);
          const ax = toPx(last.x + (bx * (rPx / unitPx)));
          const ay = toPx(last.y + (by * (rPx / unitPx)));
          angText.textContent = `${ang}°`;
          angText.setAttribute('x', String(ax));
          angText.setAttribute('y', String(ay));
        } else {
          angText.textContent = '';
        }
      } else {
        angText.textContent = '';
      }
    }

    const onMove = (e) => {
      lastMoveX = e.clientX; lastMoveY = e.clientY;
      updatePreview(e.clientX, e.clientY, shiftDown || !!e.shiftKey);
    };

    const onClick = (e) => {
      const raw = ptToUnits(e.clientX, e.clientY);
      if (currentWall.points.length >= 1 && (shiftDown || e.shiftKey)) {
        const last = currentWall.points[currentWall.points.length - 1];
        const prev = currentWall.points.length >= 2 ? currentWall.points[currentWall.points.length - 2] : null;
        currentWall.points.push(constrainWithShift(prev, last, raw));
      } else {
        currentWall.points.push(raw);
      }
      updateProgress();
      updatePreview(e.clientX, e.clientY, shiftDown || !!e.shiftKey);
    };

    async function persistWalls() {
      const payloadWalls = encodeWallsForStorage(state.walls);
      try { await api.saveWalls?.(planId, payloadWalls); } catch (e) { console.warn('saveWalls API KO', e); }
      try { localStorage.setItem(`pc_walls_${planId}`, JSON.stringify(payloadWalls)); } catch { }
    }

    const finish = async () => {
      teardown();
      if (currentWall.points.length >= 2) {
        const i = state.walls.findIndex(w => String(w.id) === String(currentWall.id));
        if (i >= 0) state.walls[i] = currentWall; else state.walls.push(currentWall);
        dedupeWallsInState();
        renderWalls();
        await persistWalls();
      }
    };

    const cancel = () => teardown();

    const onKeyDown = (e) => {
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter') finish();
      else if (e.key === 'Shift') {
        shiftDown = true;
        if (lastMoveX != null && lastMoveY != null) updatePreview(lastMoveX, lastMoveY, true);
      }
    };

    const onKeyUp = (e) => {
      if (e.key === 'Shift') {
        shiftDown = false;
        if (lastMoveX != null && lastMoveY != null) updatePreview(lastMoveX, lastMoveY, false);
      }
    };

    const onDbl = () => finish();

    function teardown() {
      $stage.removeEventListener('click', onClick);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      $stage.removeEventListener('dblclick', onDbl);
      progress.remove();
      preview.remove();
      lenText.remove();
      angText.remove();
      $stage.style.cursor = '';
      document.body.classList.remove('pc_wall_mode');
    }

    $stage.addEventListener('click', onClick);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    $stage.addEventListener('dblclick', onDbl, { once: true });
  }

  // [8] ----------------------------------------------------------------------
  // Sélection multiple, clavier, alignements & répartitions
  // -------------------------------------------------------------------------
  function handleSelectableClick(e) {
    const node = e.currentTarget;
    if (e.shiftKey) {
      if (selection.has(node)) selection.delete(node);
      else selection.add(node);
    } else {
      if (!selection.has(node)) { selection.clear(); selection.add(node); }
    }
    refreshSelectionStyling();
  }

  function refreshSelectionStyling() {
    Array.from(selection).forEach(n => { if (!n.isConnected) selection.delete(n); });

    $stage.querySelectorAll('.pc_card, .pc_furn, #pc_svg .wall').forEach(n => {
      const isSel = selection.has(n);
      n.classList.toggle('pc_selected', isSel);

      if (n.tagName === 'polyline' && n.classList.contains('wall')) {
        const wallId = String(n.dataset.wallId || '');
        if (isSel) {
          hideWallMeasures(wallId); hideWallAngles(wallId);
          const w = state.walls.find(W => String(W.id) === wallId);
          if (w) buildWallMeasuresFor(w); buildWallAnglesFor(w);
        } else {
          if (!n.matches(':hover')) { hideWallMeasures(wallId); hideWallAngles(wallId); }
        }
      }
    });
  }

  // Rectangle en unités (0..W/H du plan)
  function clampUnitsRect(r) {
    const W = state.active_plan?.width || 0, H = state.active_plan?.height || 0;
    const x0 = Math.max(0, Math.min(r.x0, W)), x1 = Math.max(0, Math.min(r.x1, W));
    const y0 = Math.max(0, Math.min(r.y0, H)), y1 = Math.max(0, Math.min(r.y1, H));
    return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  }

  function rectsOverlap(a, b) {
    return !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0);
  }

  function nodeRectUnits(node) {
    const Lpx = parseFloat(node.style.left || '0');
    const Tpx = parseFloat(node.style.top || '0');
    const Wpx = parseFloat(node.style.width || '0');
    const Hpx = parseFloat(node.style.height || '0');
    const Lu = Lpx / unitPx, Tu = Tpx / unitPx, Wu = Wpx / unitPx, Hu = Hpx / unitPx;
    const rot = parseFloat(node.dataset.rotAbs || node.dataset.rot || '0') || 0;
    const r = rectFromTopLeftWithRotation(Lu, Tu, Wu, Hu, rot);
    return { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
  }

  // Applique la sélection par rectangle (unités). Si add==true → ajoute, sinon remplace.
  function selectWithinRectUnits(selRect, add) {
    const R = clampUnitsRect(selRect);
    if (!add) selection.clear();

    $stage.querySelectorAll('.pc_card, .pc_furn').forEach(node => {
      const nr = nodeRectUnits(node);
      if (rectsOverlap(R, nr)) selection.add(node);
    });

    if ($svg && Array.isArray(state.walls)) {
      state.walls.forEach(w => {
        const pts = w.points || [];
        const hit = pts.some(p => p.x >= R.x0 && p.x <= R.x1 && p.y >= R.y0 && p.y <= R.y1)
          || pts.some((p, i) => i < pts.length - 1 && segIntersectsRect(p, pts[i + 1], R));
        if (hit) {
          const poly = $svg.querySelector(`.wall[data-wall-id="${String(w.id)}"]`);
          if (poly) selection.add(poly);
        }
      });
    }

    refreshSelectionStyling();
  }

  function startMarquee(ev) {
    if (document.body.classList.contains('pc_wall_mode')) return;
    if (ev.button && ev.button !== 0) return;

    const isOnItem = ev.target.closest('.pc_card, .pc_furn, #aw_start_handle') ||
      (ev.target.tagName === 'polyline' && ev.target.classList.contains('wall'));

    if (isOnItem) return;

    const box = stageInnerBox();
    const inside = ev.clientX >= box.left && ev.clientX <= (box.left + box.width) &&
      ev.clientY >= box.top && ev.clientY <= (box.top + box.height);
    if (!inside) return;

    marqueeData = {
      sx: ev.clientX,
      sy: ev.clientY,
      add: !!ev.shiftKey,
      box,
      moved: false
    };

    marqueeEl = document.createElement('div');
    marqueeEl.className = 'pc_marquee';
    marqueeEl.style.position = 'absolute';
    marqueeEl.style.left = '0'; marqueeEl.style.top = '0';
    marqueeEl.style.border = '1.5px dashed #3b82f6';
    marqueeEl.style.background = 'rgba(59,130,246,.12)';
    marqueeEl.style.pointerEvents = 'none';
    marqueeEl.style.zIndex = '9998';
    $stage.appendChild(marqueeEl);

    $stage.setPointerCapture?.(ev.pointerId);
    $stage.addEventListener('pointermove', onMarqueeMove);
    $stage.addEventListener('pointerup', endMarquee, { once: true });
  }

  function onMarqueeMove(e) {
    if (!marqueeData || !marqueeEl) return;
    const { box, sx, sy } = marqueeData;

    const cx = Math.max(box.left, Math.min(e.clientX, box.left + box.width));
    const cy = Math.max(box.top, Math.min(e.clientY, box.top + box.height));
    const dx = Math.abs(cx - sx);
    const dy = Math.abs(cy - sy);
    if (!marqueeData.moved && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) {
      marqueeData.moved = true;
    }

    const x0px = Math.min(sx, cx) - box.left;
    const y0px = Math.min(sy, cy) - box.top;
    const wpx = Math.abs(cx - sx);
    const hpx = Math.abs(cy - sy);

    marqueeEl.style.left = `${x0px}px`;
    marqueeEl.style.top = `${y0px}px`;
    marqueeEl.style.width = `${wpx}px`;
    marqueeEl.style.height = `${hpx}px`;

    const x0u = (Math.min(sx, cx) - box.left) / unitPx;
    const y0u = (Math.min(sy, cy) - box.top) / unitPx;
    const x1u = x0u + (wpx / unitPx);
    const y1u = y0u + (hpx / unitPx);
    selectWithinRectUnits({ x0: x0u, y0: y0u, x1: x1u, y1: y1u }, marqueeData.add);
  }

  function endMarquee(e) {
    $stage.removeEventListener('pointermove', onMarqueeMove);
    const clickOnly = marqueeData && !marqueeData.moved;

    if (marqueeEl) marqueeEl.remove();
    marqueeEl = null;

    if (clickOnly) {
      selection.clear();
      refreshSelectionStyling();
    }

    marqueeData = null;
  }

  function nudgeSelection(dxPx, dyPx) {
    if (!selection.size) return;

    let movedWall = false;
    let movedFurn = false;

    selection.forEach(n => {
      const isCard = n.classList.contains('pc_card');
      const isFurn = n.classList.contains('pc_furn');
      const isWall = n.tagName === 'polyline' && n.classList.contains('wall');

      if (isCard || isFurn) {
        const L = parseFloat(n.style.left || '0');
        const T = parseFloat(n.style.top || '0');
        n.style.left = (L + dxPx) + 'px';
        n.style.top = (T + dyPx) + 'px';
      }

      if (isCard) {
        const id = parseInt(n.dataset.eleveId, 10);
        const fp = footprintCardUnits();
        const rot = parseFloat(n.dataset.rotAbs || n.dataset.rot || '0') || 0;

        const box = stageInnerBox();
        const pxAdj = adjustClientPxForSwap(
          box.left + parseFloat(n.style.left || '0'),
          box.top + parseFloat(n.style.top || '0'),
          fp.w, fp.h, rot
        );
        const { x: gx, y: gy } = clientToUnitsClamped(pxAdj.leftPx, pxAdj.topPx, pxAdj.wEff, pxAdj.hEff);

        const p = state.positions.find(p => p.eleve_id === id);
        if (p) { p.x = snapUnits(gx - pxAdj.dx); p.y = snapUnits(gy - pxAdj.dy); }
      } else if (isFurn) {
        const id = parseInt(n.dataset.id, 10);
        const f = state.furniture.find(x => x.id === id);
        if (f) {
          const W = parseFloat(n.style.width || '0');
          const H = parseFloat(n.style.height || '0');
          const gw = Math.max(TICK, Math.ceil((W / unitPx) * UI_SUBDIV) / UI_SUBDIV);
          const gh = Math.max(TICK, Math.ceil((H / unitPx) * UI_SUBDIV) / UI_SUBDIV);
          const rotNow = parseFloat(n.dataset.rotAbs || n.dataset.rot || '0') || 0;

          const box = stageInnerBox();
          const pxAdj = adjustClientPxForSwap(
            box.left + parseFloat(n.style.left || '0'),
            box.top + parseFloat(n.style.top || '0'),
            gw, gh, rotNow
          );
          const { x: gx, y: gy } = clientToUnitsClamped(pxAdj.leftPx, pxAdj.topPx, pxAdj.wEff, pxAdj.hEff);

          const newX = snapUnits(gx - pxAdj.dx);
          const newY = snapUnits(gy - pxAdj.dy);
          const t = (n.dataset.furnitureType || '').toLowerCase();
          if ((t === 'door' || t === 'window') && state.walls.length) {
            const center = { x: newX + (pxAdj.wEff / 2), y: newY + (pxAdj.hEff / 2) };
            const s = snapToNearestWall(center.x, center.y, 0.6);
            if (s) {
              const cx = snapUnits(s.point.x), cy = snapUnits(s.point.y);
              const nx = snapUnits(cx - (pxAdj.wEff / 2));
              const ny = snapUnits(cy - (pxAdj.hEff / 2));
              if (nx !== newX || ny !== newY) { movedFurn = true; }
              f.x = nx; f.y = ny;
              const r = Math.round(s.angleDeg);
              if (f.rotAbs !== r) { f.rotAbs = r; f.rotation = ((r % 360) + 360) % 360; movedFurn = true; }
            } else {
              if (newX !== f.x || newY !== f.y) movedFurn = true;
              f.x = newX; f.y = newY;
            }
          } else {
            if (newX !== f.x || newY !== f.y) movedFurn = true;
            f.x = newX; f.y = newY;
          }
          f.w = gw; f.h = gh;
        }
      } else if (isWall) {
        const wallId = n.dataset.wallId;
        const w = state.walls.find(W => String(W.id) === String(wallId));
        if (!w || !Array.isArray(w.points)) return;

        let du = dxPx / unitPx;
        let dv = dyPx / unitPx;

        if (state.active_plan) {
          const Wp = state.active_plan.width, Hp = state.active_plan.height;
          const xs = w.points.map(p => p.x), ys = w.points.map(p => p.y);
          const minX = Math.min(...xs), maxX = Math.max(...xs);
          const minY = Math.min(...ys), maxY = Math.max(...ys);
          du = Math.max(-minX, Math.min(du, Wp - maxX));
          dv = Math.max(-minY, Math.min(dv, Hp - maxY));
        }

        if (du !== 0 || dv !== 0) {
          w.points = w.points.map(p => ({ x: snapUnits(p.x + du), y: snapUnits(p.y + dv) }));
          n.setAttribute('points', w.points.map(p => `${toPx(p.x)},${toPx(p.y)}`).join(' '));
          movedWall = true;
        }
      }
    });

    autosavePositions();
    if (movedFurn) autosaveFurniture();
    if (movedWall) {
      autosaveWalls();
      updateWallMeasures();
      refreshSelectionStyling();
    }
  }

  // rect stockage (coin TL) → rect effectif (swap 90°/270°)
  function rectFromTopLeftWithRotation(x, y, w, h, rot) {
    const swap = isQuarterTurnSwap(rot);
    const wEff = swap ? h : w;
    const hEff = swap ? w : h;
    const dx = swap ? (w - wEff) / 2 : 0;
    const dy = swap ? (h - hEff) / 2 : 0;
    return { x: snapUnits(x + dx), y: snapUnits(y + dy), w: wEff, h: hEff };
  }
  // correction coin TL en px si swap 90°/270°
  function adjustClientPxForSwap(leftPx, topPx, w, h, rot) {
    const swap = isQuarterTurnSwap(rot);
    if (!swap) return { leftPx, topPx, wEff: w, hEff: h, dx: 0, dy: 0 };
    const wEff = h, hEff = w;
    const dx = (w - wEff) / 2;
    const dy = (h - hEff) / 2;
    return { leftPx: leftPx + toPx(dx), topPx: topPx + toPx(dy), wEff, hEff, dx, dy };
  }

  // --- Alignements & distributions (type Word), compatibles rotation 90°/270°
  function _rectForAlignPx(n) {
    // Récup px depuis le DOM
    const L = parseFloat(n.style.left || '0');
    const T = parseFloat(n.style.top || '0');
    const W = parseFloat(n.style.width || '0');
    const H = parseFloat(n.style.height || '0');

    const rot = parseFloat(n.dataset.rotAbs || n.dataset.rot || '0') || 0;
    const a = ((rot % 360) + 360) % 360;
    const swap = (a === 90 || a === 270);

    // Boîte englobante visible en px (type Word)
    const wEff = swap ? H : W;
    const hEff = swap ? W : H;
    const dx = swap ? (W - wEff) / 2 : 0; // correction TL -> TL_effectif
    const dy = swap ? (H - hEff) / 2 : 0;

    // On retourne aussi dx/dy pour pouvoir reposer left/top d’origine
    return { n, L: L + dx, T: T + dy, W: wEff, H: hEff, dx, dy };
  }

  function alignSelection(side) {
    const nodes = Array.from(selection).filter(n =>
      n.classList.contains('pc_card') || n.classList.contains('pc_furn')
    );
    if (nodes.length < 2) return;

    const rects = nodes.map(_rectForAlignPx);

    const minL = Math.min(...rects.map(r => r.L));
    const maxR = Math.max(...rects.map(r => r.L + r.W));
    const minT = Math.min(...rects.map(r => r.T));
    const maxB = Math.max(...rects.map(r => r.T + r.H));

    rects.forEach(r => {
      if (side === 'left') r.n.style.left = `${(minL - r.dx)}px`;
      if (side === 'right') r.n.style.left = `${(maxR - r.W - r.dx)}px`;
      if (side === 'top') r.n.style.top = `${(minT - r.dy)}px`;
      if (side === 'bottom') r.n.style.top = `${(maxB - r.H - r.dy)}px`;
    });

    // Commit dans le state (positions, furniture) via ton pipeline existant
    nudgeSelection(0, 0);
  }

  function distributeSelection(orientation /* 'h' ou 'v' */) {
    const nodes = Array.from(selection).filter(n =>
      n.classList.contains('pc_card') || n.classList.contains('pc_furn')
    );
    if (nodes.length < 3) return;

    const rects = nodes.map(_rectForAlignPx);

    if (orientation === 'h') {
      // Tri gauche→droite
      rects.sort((a, b) => a.L - b.L);
      const minL = rects[0].L;
      const maxR = Math.max(...rects.map(r => r.L + r.W));
      const totalW = rects.reduce((s, r) => s + r.W, 0);
      const gap = (maxR - minL - totalW) / (rects.length - 1);

      let cur = minL;
      rects.forEach((r, i) => {
        if (i === 0) return;                       // garde l’extrême gauche
        cur += rects[i - 1].W + gap;               // position cible L_effectif
        if (i === rects.length - 1) return;        // garde l’extrême droite
        r.n.style.left = `${(cur - r.dx)}px`;      // re-calcule left d’origine
      });
    } else {
      // Tri haut→bas
      rects.sort((a, b) => a.T - b.T);
      const minT = rects[0].T;
      const maxB = Math.max(...rects.map(r => r.T + r.H));
      const totalH = rects.reduce((s, r) => s + r.H, 0);
      const gap = (maxB - minT - totalH) / (rects.length - 1);

      let cur = minT;
      rects.forEach((r, i) => {
        if (i === 0) return;                       // haut
        cur += rects[i - 1].H + gap;
        if (i === rects.length - 1) return;        // bas
        r.n.style.top = `${(cur - r.dy)}px`;
      });
    }

    nudgeSelection(0, 0);
  }


  function restoreWallsForPlan() {
    if (!state.active_plan) return;
    const planId = state.active_plan.id;

    if (Array.isArray(state.walls) && state.walls.length) {
      renderWalls();
      return;
    }
    try {
      const raw = localStorage.getItem(`pc_walls_${planId}`);
      const stored = raw ? JSON.parse(raw) : [];
      state.walls = decodeWallsFromStorage(stored);
    } catch {
      state.walls = [];
    }
    renderWalls();
  }

  // [9] ----------------------------------------------------------------------
  // Suppression (élève / meuble / mur)
  // -------------------------------------------------------------------------

  function removeElement(el) {
    if (!state.active_plan) return;

    if (el.tagName === 'polyline' && el.classList.contains('wall')) {
      const wallId = el.dataset.wallId;
      hideWallMeasures(String(wallId));
      hideWallAngles(String(wallId));
      const before = state.walls.length;
      state.walls = state.walls.filter(w => String(w.id) !== String(wallId));
      el.remove();
      if (before !== state.walls.length) autosaveWalls();
      selection.delete(el);
      refreshSelectionStyling();
      cleanupOrphanMeasures();
      return;
    }

    const typ = el.dataset.type;

    if (typ === 'eleve') {
      const eleveId = parseInt(el.dataset.id, 10);
      api.deletePosition(state.active_plan.id, eleveId).then(() => {
        state.positions = state.positions.filter(p => p.eleve_id !== eleveId);
        el.remove();
        renderEleveList();
        selection.delete(el);
        refreshSelectionStyling();
      }).catch(err => {
        console.error(err);
        alert("Suppression impossible (élève).");
      });
      return;
    }

    if (typ === 'furniture') {
      const fid = parseInt(el.dataset.id, 10);

      if (!fid || fid < 0) {
        const f = state.furniture.find(x => x.id === fid);
        if (f?.uid) sentNewFurniture.delete(f.uid);
        state.furniture = state.furniture.filter(f => f.id !== fid);
        el.remove();
        selection.delete(el);
        refreshSelectionStyling();
        return;
      }

      api.deleteFurniture(state.active_plan.id, fid).then(() => {
        state.furniture = state.furniture.filter(f => f.id !== fid);
        lsDelColor(state.active_plan.id, fid);
        el.remove();
        selection.delete(el);
        refreshSelectionStyling();
      }).catch(err => {
        console.error(err);
        alert("Suppression impossible (meuble).");
      });
    }
  }

  // [10] ---------------------------------------------------------------------
  // Boot / Chargement
  // -------------------------------------------------------------------------

  function fromDBPosition(p) {
    const pid = state.active_plan?.id || p.plan_id;
    const ls = pid ? lsGetPosRots(pid) : {};
    const raw = (p.rot ?? p.rotation);
    const rotRaw = Number.isFinite(raw) ? Number(raw)
      : (Number.isFinite(ls?.[p.eleve_id]) ? Number(ls[p.eleve_id]) : 0);
    const rot = snapRotStudent(rotRaw);
    return {
      ...p,
      x: (+p.x || 0) / PLAN_SUBDIV,
      y: (+p.y || 0) / PLAN_SUBDIV,
      rot, rotAbs: rot
    };
  }

  async function boot(planIdToShow = null) {
    try {
      document.body.classList.add('pc_loading');

      const data = await api.getAll(planIdToShow);

      const plans = Array.isArray(data.plans) ? data.plans : [];
      const eleves = Array.isArray(data.eleves) ? data.eleves : [];
      const seats = Array.isArray(data.seats) ? data.seats : [];
      const apiWallsEnc = Array.isArray(data.walls) ? data.walls : [];

      const pickActivePlan = (plans, currentActive, apiActive) => {
        if (apiActive) return apiActive;
        if (currentActive) {
          const keep = plans.find(p => p.id === currentActive.id);
          if (keep) return keep;
        }
        return plans[0] || null;
      };
      const active_plan = pickActivePlan(plans, state.active_plan, data.active_plan);

      PLAN_SUBDIV = 32; UI_SUBDIV = 32;

      const positions = Array.isArray(data.positions) ? data.positions.map(fromDBPosition) : [];

      const prevTmpByUid = new Map((state.furniture || []).filter(ff => ff && ff.id < 0 && ff.uid).map(ff => [ff.uid, ff]));
      const prevColorById = new Map((state.furniture || []).filter(ff => ff && ff.id > 0).map(ff => [ff.id, ff.color]));

      const furniture = (Array.isArray(data.furniture) ? data.furniture : [])
        .filter(f => String(f.type || '').toLowerCase() !== 'wall')
        .map(f => {
          const rot = round1(norm360(parseFloat(f.rotation ?? f.rotAbs ?? 0)));


          let color = (f.color != null ? f.color : null);
          if (color == null && active_plan && f.id > 0) {
            color = lsGetColor(active_plan.id, f.id) || prevColorById.get(f.id) || null;
          }
          const prevTmp = f.client_uid ? prevTmpByUid.get(f.client_uid) : null;
          if (color == null && prevTmp?.color) color = prevTmp.color;

          const t = (f.type || 'autre').toLowerCase().replace(/\s+/g, '_');
          if (color == null) color = FURN_COLORS[t] || FURN_DEF_COLORS[t] || null;
          if (active_plan && f.id > 0 && color) lsSetColor(active_plan.id, f.id, color);

          return {
            ...f,
            x: (+f.x || 0) / PLAN_SUBDIV,
            y: (+f.y || 0) / PLAN_SUBDIV,
            w: (+f.w || 1) / PLAN_SUBDIV,
            h: (+f.h || 1) / PLAN_SUBDIV,
            rotation: rot,
            rotAbs: rot,
            color,
            radius: !!f.radius
          };
        });

      const walls = decodeWallsFromStorage(apiWallsEnc);

      state = { ...state, plans, active_plan, eleves, positions, furniture, seats, walls };
      sentNewFurniture.clear();

      render();
      refreshToolbarActionsEnabled();
      if (pendingSelSnap) {
        restoreSelectionFromSnapshot(pendingSelSnap);
        pendingSelSnap = null;
      }
    } catch (err) {
      console.error('[boot] fail', err);
      alert("Impossible de charger les plans de classe pour le moment.");
    } finally {
      document.body.classList.remove('pc_loading');
    }
  }

  function segIntersectsRect(a, b, R) {
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    if (maxX < R.x0 || minX > R.x1 || maxY < R.y0 || minY > R.y1) return false;
    const line = (p, q, r) => (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
    const onSeg = (p, q, r) => Math.min(p.x, r.x) <= q.x && q.x <= Math.max(p.x, r.x) && Math.min(p.y, r.y) <= q.y && q.y <= Math.max(p.y, r.y);
    const inter = (p1, q1, p2, q2) => {
      const o1 = line(p1, q1, p2), o2 = line(p1, q1, q2), o3 = line(p2, q2, p1), o4 = line(p2, q2, q1);
      if ((o1 === 0 && onSeg(p1, p2, q1)) || (o2 === 0 && onSeg(p1, q2, q1)) || (o3 === 0 && onSeg(p2, p1, q2)) || (o4 === 0 && onSeg(p2, q1, q2))) return true;
      return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
    };
    const tl = { x: R.x0, y: R.y0 }, tr = { x: R.x1, y: R.y0 }, br = { x: R.x1, y: R.y1 }, bl = { x: R.x0, y: R.y1 };
    return inter(a, b, tl, tr) || inter(a, b, tr, br) || inter(a, b, br, bl) || inter(a, b, bl, tl);
  }

  function currentPlanIdSafe() {
    const v = $sel?.value;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const a = Number(state?.active_plan?.id);
    return (Number.isFinite(a) && a > 0) ? a : null;
  }

  // [11] ---------------------------------------------------------------------
  // Toolbar (actions de plan) & Listeners globaux
  // -------------------------------------------------------------------------

  $sel?.addEventListener('change', async () => {
    const id = parseInt($sel.value, 10);
    if (!Number.isFinite(id)) return;
    await api.activate(id);
    await boot(id);
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

  $edit?.addEventListener('click', () => { editMode = !editMode; refreshFurnitureEditability(); });

  $delPlan?.addEventListener('click', async () => {
    const planId = currentPlanIdSafe();
    if (!planId) { alert("Aucun plan valide sélectionné."); return; }

    const name = $sel?.selectedOptions?.[0]?.text || `Plan ${planId}`;
    if (!confirm(`Supprimer le plan « ${name} » ?\nCette action est irréversible.`)) return;

    const ok = await api.deletePlan(planId);
    if (!ok) { alert("Suppression côté serveur non confirmée."); return; }

    await boot();
    if ($sel && state.active_plan) {
      $sel.value = String(state.active_plan.id);
      $sel.dispatchEvent(new Event('change'));
    }
  });

  // Clavier global : suppression, déplacements, alignements & répartitions
  window.addEventListener('keydown', (e) => {
    if (!state.active_plan) return;
    const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key);
    const ctrlAlt = e.ctrlKey && e.altKey;

    if (e.key === 'Delete') {
      selection.forEach(n => removeElement(n));
      selection.clear(); refreshSelectionStyling();
      e.preventDefault(); return;
    }

    if (arrow) {
      // Raccourcis d’alignement/distribution
      if (ctrlAlt) {
        if (e.shiftKey) {
          // Distribution (h/v) avec Ctrl+Alt+Shift+Flèche
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') distributeSelection('h');
          else distributeSelection('v');
        } else {
          // Alignements avec Ctrl+Alt+Flèche
          if (e.key === 'ArrowLeft') alignSelection('left');
          if (e.key === 'ArrowRight') alignSelection('right');
          if (e.key === 'ArrowUp') alignSelection('top');
          if (e.key === 'ArrowDown') alignSelection('bottom');
        }
        e.preventDefault();
        return;
      }

      // Déplacement fin/rapide de la sélection
      let stepPx = 1;                 // fin
      if (e.shiftKey) stepPx = 10;    // rapide
      if (e.altKey && !e.ctrlKey) {   // pas de conflit avec Ctrl+Alt
        stepPx = Math.max(1, Math.round(unitPx / UI_SUBDIV));
      }

      const dx = (e.key === 'ArrowLeft' ? -stepPx : e.key === 'ArrowRight' ? stepPx : 0);
      const dy = (e.key === 'ArrowUp' ? -stepPx : e.key === 'ArrowDown' ? stepPx : 0);

      if (dx || dy) {
        nudgeSelection(dx, dy);
        e.preventDefault();
      }
      return;
    }

    // Échap: vide la sélection (hors mode mur déjà géré dans startWallTool)
    if (e.key === 'Escape') {
      selection.clear();
      refreshSelectionStyling();
    }
  });

  // Sélection rectangulaire sur le stage (marquee)
  $stage?.addEventListener('pointerdown', startMarquee);

  // Fullscreen (réadapte l’échelle et recalcule les mesures visibles)
  setupFullscreenExact($wrap, () => {
    fitStageToWrap();
    refreshDomScaleFromState();
  }, () => {
    renderWalls();
    updateWallMeasures();
    $stage.querySelectorAll('.pc_furn').forEach(updateFurnitureMeasures);
  });

  // Resize fenêtre → refit + refresh mesures
  window.addEventListener('resize', () => {
    fitStageToWrap();
    refreshDomScaleFromState();
    renderWalls();
    updateWallMeasures();
    $stage.querySelectorAll('.pc_furn').forEach(updateFurnitureMeasures);
  });


















  // Boot initial
  boot().catch(console.error);
})();



