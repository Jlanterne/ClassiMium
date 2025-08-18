/* ============================================================================
   plan_classe.js — ÉDITEUR DE PLAN DE CLASSE (version refactor)
   ============================================================================

   SOMMAIRE
   --------
   [0]  Bootstrap & Constants
   [1]  Utils (unités/px, géométrie, couleurs, localStorage)
   [2]  API client (fetch)
   [3]  Autosave (positions, meubles, murs) & resync contrôlé
   [4]  Stage fit + Grille + Fullscreen
   [5]  Collisions & "collapse" (aimantation bord à bord)
   [6]  Rendu: élèves, meubles, murs (SVG), palette
   [7]  Drag & Drop:
        7.1 Élève depuis la liste (ghost final)
        7.2 Déplacement carte élève
        7.3 Création meuble depuis palette (ghost final)
        7.4 Déplacement / redimension meuble + rotation
        7.5 Tracé de murs (polyline SVG)
   [8]  Sélection multiple, clavier, alignements & répartitions
   [9]  Suppression (élève / meuble / mur), couleur & coins arrondis
   [10] Boot (chargement, mapping id temp -> id serveur, persistance couleurs)
   [11] Toolbar (actions de plan) & Listeners globaux

   Points clés
   ----------
   • Couleur PAR MEUBLE => sauvegarde unitaire immédiate ; boot() ne les écrase pas.
   • Anti-duplication => Set(uid) lors des PUT, mapping client_uid sur boot().
   • Murs en SVG (hachures) + portes/fenêtres forcement sur mur (snap).
   • Fantômes (élèves/meubles) identiques à l’objet final pendant le drag.
   • Sélection multiple, déplacements clavier, alignements/distrib à la Word.

   Échelle
   -------
   • 1 unité = 25 cm (CM_PER_UNIT = 25).
   • Empreinte élève ≈ 70x50 cm, aimantée aux ticks UI.
============================================================================ */

(() => {
  // [0] ----------------------------------------------------------------------
  // Bootstrap & Constants
  // -------------------------------------------------------------------------

  const $stage = document.getElementById('pc_stage');
  if (!$stage) return;

  const conf = window.SEATING_CONF || {};
  const classeId = conf.classeId || parseInt($stage.dataset.classeId, 10);
  const API_BASE = (conf.apiBase || "/seating") + "/api";
  const PHOTOS_BASE = conf.photosBase || "/static/photos/";

  let UI_SUBDIV = 32;   // précision UI (ticks aimantation)
  let PLAN_SUBDIV = 32;  // précision stockage API
  let unitPx = 32;   // dimension d'une unité en pixels (calculée par autofit)

  // ids temporaires (meubles) & mode édition
  let tempIdSeq = -1;
  let editMode = false;

  // ---- Échelle réelle pour les élèves
  const CM_PER_UNIT = 25;  // 1 unité = 25 cm
  const STUDENT_W_CM = 70;
  const STUDENT_H_CM = 50;
  const cmToUnits = (cm) => cm / CM_PER_UNIT;

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

  // empreinte élève (en unités), aimantée aux ticks
  function studentFootprintUnits() {
    // Alias pour compat rétro : certains appels utilisent footprintCardUnits()


    const w = Math.max(TICK, Math.round(cmToUnits(STUDENT_W_CM) * UI_SUBDIV) / UI_SUBDIV);
    const h = Math.max(TICK, Math.round(cmToUnits(STUDENT_H_CM) * UI_SUBDIV) / UI_SUBDIV);
    return { w, h };
  }
  // ✅ Alias global pour compat rétro (utilisé par ton code existant)
  const footprintCardUnits = studentFootprintUnits;

  // helpers sélection
  const selection = new Set();
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
    if (e.shiftKey) {
      if (selection.has(node)) selection.delete(node); else selection.add(node);
    } else {
      selection.clear(); selection.add(node);
    }
    refreshSelectionStyling();
    // mémoriser les positions de départ pour le drag groupé
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

  // --- Helpers pour POST/PUT/DELETE avec cookie + CSRF ------------------------
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

  // Retourne {} si 204/no JSON, sinon parse le JSON. Lance une erreur si !r.ok
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

  const debounce = (fn, d = 600) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); }; };

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
  const autosaveFurniture = (() => {
    let timer = null;
    return () => {
      if (!state.active_plan) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
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
              rotation: norm360(Math.round((f.rotAbs ?? f.rotation ?? 0))),
              z: f.z || 0,
              radius: !!f.radius
            }));

          if (!payload.length) return;

          const createdUIDs = payload.filter(p => !p.id && p.client_uid).map(p => p.client_uid);
          createdUIDs.forEach(uid => sentNewFurniture.add(uid));

          await api.saveFurniture(state.active_plan.id, payload);

          if (createdUIDs.length && !isDraggingNow) {
            pendingSelSnap = selectionSnapshot();
            resyncSoon(0);
          }
        } catch (err) {
          console.error('[autosaveFurniture] PUT failed', err);
          sentNewFurniture.clear();
        }
      }, 500);
    };
  })();

  // autosave murs (déplacés au clavier)
  const autosaveWalls = debounce(async () => {
    if (!state.active_plan) return;
    dedupeWallsInState();                                // ← AJOUT
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
      rotation: norm360(Math.round((f.rotAbs ?? f.rotation ?? 0))),
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
    const maxR = 80;
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
    if ($svg) { $svg.innerHTML = '<defs></defs>'; ensureHatchPattern(); }
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
    if (snap) { if (visu > 90) visu = 90; if (visu < -90) visu = -90; } // bornes lisibilité

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

    // UI boutons: masque celui vers la borne atteinte (si snap)
    const leftBtn = card.querySelector('.pc_rot_btn.rot-left');
    const rightBtn = card.querySelector('.pc_rot_btn.rot-right');
    if (leftBtn && rightBtn && snap) {
      if (visu === 0) { leftBtn.style.display = "inline-block"; rightBtn.style.display = "inline-block"; }
      else if (visu === -90) { leftBtn.style.display = "none"; rightBtn.style.display = "inline-block"; }
      else if (visu === 90) { rightBtn.style.display = "none"; leftBtn.style.display = "inline-block"; }
    }
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
    const initVisu = (initRotAbs === 270) ? -90 : initRotAbs; // -90/0/90 pour l’affichage
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
      limitSelectionToKind(card);
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
    el.addEventListener('wheel', (e) => { if (!e.altKey) return; e.preventDefault(); setFurnitureRotation(el, (e.deltaY > 0 ? -5 : 5)); }, { passive: false });
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
        el.style.borderRadius = f.radius ? '12px' : '0';
        btn.textContent = f.radius ? '◯' : '◻︎';
        saveFurnitureItemImmediate(f);
      });
      el.appendChild(btn);
    }
    btn.style.display = editMode ? 'block' : 'none';
  }
  function setFurnitureRotation(el, delta) {
    const abs = (parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0) + delta;
    el.dataset.rotAbs = String(abs);
    el.style.transform = `rotate(${abs}deg)`;
    const id = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
    const f = (id != null) ? state.furniture.find(x => x.id === id) : null;
    if (f) { f.rotAbs = abs; f.rotation = norm360(abs); autosaveFurniture(); }
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
  }

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

      if (f.rotation != null) el.dataset.rot = String(f.rotation);
      if (f.rotAbs != null) el.dataset.rotAbs = String(f.rotAbs);

      el.style.left = `${toPx(f.x)}px`;
      el.style.top = `${toPx(f.y)}px`;
      el.style.width = `${toPx(f.w)}px`;
      el.style.height = `${toPx(f.h)}px`;
      el.style.transformOrigin = 'center center';
      el.style.transform = `rotate(${el.dataset.rotAbs || el.dataset.rot || 0}deg)`;
      if (f.radius) el.style.borderRadius = '12px';

      const color = f.color || FURN_COLORS[t] || null; if (color) applyFurnitureColor(el, t, color);

      const label = document.createElement('div'); label.className = 'label'; label.textContent = f.label || f.type || 'meuble';

      const makeHandle = dir => { const h = document.createElement('div'); h.className = `rz ${dir}`; h.dataset.dir = dir; h.title = 'Redimensionner'; h.addEventListener('pointerdown', startResizeFurniture); return h; };

      el.append(label, makeHandle('nw'), makeHandle('ne'), makeHandle('se'), makeHandle('sw'));
      addDeleteButton(el); addFurnRotate(el); addFurnCornerToggle(el);
      el.addEventListener('pointerdown', (e) => {
        if (e.button && e.button !== 0) return;
        if (e.target.closest('.pc_delete_btn')) return;
        if (e.target.classList.contains('rz')) return;
        selectNodeOnPointerDown(el, e);
        limitSelectionToKind(el);
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

  function renderEleveList() {
    if (!$elist) return; $elist.innerHTML = '';
    const placed = new Set(state.positions.map(p => p.eleve_id));
    for (const e of state.eleves) {
      if (placed.has(e.id)) continue;
      const item = document.createElement('div'); item.className = 'pc_eleve_item'; item.dataset.eleveId = e.id; item.draggable = false;
      const img = document.createElement('img'); img.src = PHOTOS_BASE + (e.photo_filename || 'default.jpg'); img.draggable = false;
      const name = document.createElement('div'); name.className = 'name'; name.textContent = `${e.prenom} ${e.nom}`;
      item.append(img, name);
      item.addEventListener('pointerdown', startDragFromList);
      $elist.appendChild(item);
    }
  }

  function renderWalls() {
    if (!$svg) return;
    dedupeWallsInState();
    ensureHatchPattern();
    $svg.querySelectorAll('.wall, .wall-draft, .wall-preview').forEach(n => n.remove());

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

      const pts = w.points.map(p => `${toPx(p.x)},${toPx(p.y)}`).join(' ');
      poly.setAttribute('points', pts);
      $svg.appendChild(poly);
    }
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
      dragData = null;
      isDraggingNow = false;
      return;
    }

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
    return (Math.sqrt(best.d2) <= maxDist) ? best.p : null;
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
        // centre l’objet sur le mur
        drop = { x: snapUnits(s.x - wEff / 2), y: snapUnits(s.y - hEff / 2) };
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
        rotation: 0, rotAbs: 0, z: 0,
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
    isDraggingNow = true;

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
  function endDragFurniture(ev) {
    const el = ev.currentTarget;
    el.releasePointerCapture(ev.pointerId);
    el.removeEventListener('pointermove', onDragFurnitureMove);

    if (!dragData || !dragData.moved) {
      dragData = null;
      isDraggingNow = false;
      return;
    }

    nudgeSelection(0, 0); // commit px→unités (autosave)
    dragData = null;
    isDraggingNow = false;
  }

  function startResizeFurniture(ev) {
    const el = ev.currentTarget.parentElement;
    const dir = ev.currentTarget.dataset.dir;
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

    // considéré comme un drag en cours
    isDraggingNow = true;

    const L = parseFloat(el.style.left || '0');
    const T = parseFloat(el.style.top || '0');
    const W = parseFloat(el.style.width || '0');
    const H = parseFloat(el.style.height || '0');
    const gw = Math.max(TICK, Math.ceil((W / unitPx) * UI_SUBDIV) / UI_SUBDIV);
    const gh = Math.max(TICK, Math.ceil((H / unitPx) * UI_SUBDIV) / UI_SUBDIV);

    const rotNow = parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0;
    const swapNow = isQuarterTurnSwap(rotNow);
    const wEff = swapNow ? gh : gw, hEff = swapNow ? gw : gh;

    const box = stageInnerBox();
    const { x: gx, y: gy } = clientToUnitsClamped(box.left + L, box.top + T, wEff, hEff);

    const id = (dragData && dragData.id != null) ? dragData.id : null;
    let spot = findNearestFreeSpot(gx, gy, wEff, hEff, { furnitureId: id ?? -1 });
    if (!spot) { shake(el); dragData = null; isDraggingNow = false; return; }
    spot = snapCollapse(spot, rectsInPlan({ furnitureId: id ?? -1 }));

    const f = (id != null) ? state.furniture.find(x => x.id === id) : null;
    if (f) { f.w = gw; f.h = gh; f.x = spot.x; f.y = spot.y; }

    autosaveFurniture();
    dragData = null;
    isDraggingNow = false;
  }

  // 7.5 Tracé des murs (SVG)
  function startWallTool(ev) {
    ev?.preventDefault?.();
    if (document.body.classList.contains('pc_wall_mode')) return;
    if (!$svg || !$stage || !state.active_plan) return;
    $svg.querySelectorAll('.wall-draft, .wall-preview').forEach(n => n.remove());

    const planId = state.active_plan.id;
    let currentWall = { id: genUid(), points: [] };

    const progress = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    progress.classList.add('wall-draft');
    progress.setAttribute('fill', 'none');
    progress.setAttribute('stroke', 'url(#hatch)');
    progress.setAttribute('stroke-width', Math.max(3, unitPx * 0.12));
    $svg.appendChild(progress);

    const preview = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    preview.classList.add('wall-preview');
    preview.setAttribute('fill', 'none');
    preview.setAttribute('stroke', '#60a5fa');
    preview.setAttribute('stroke-width', Math.max(2, unitPx * 0.10));
    preview.setAttribute('stroke-dasharray', '6 4');
    $svg.appendChild(preview);

    progress.style.pointerEvents = 'none';
    preview.style.pointerEvents = 'none';

    $stage.style.cursor = 'crosshair';
    document.body.classList.add('pc_wall_mode');

    const box = stageInnerBox();
    const ptToUnits = (cx, cy) => ({
      x: snapUnits((cx - box.left) / unitPx),
      y: snapUnits((cy - box.top) / unitPx),
    });

    const updateProgress = () => {
      if (currentWall.points.length < 2) { progress.setAttribute('points', ''); return; }
      const pts = currentWall.points.map(p => `${toPx(p.x)},${toPx(p.y)}`).join(' ');
      progress.setAttribute('points', pts);
    };

    const updatePreview = (clientX, clientY) => {
      if (!currentWall.points.length) { preview.setAttribute('points', ''); return; }
      const last = currentWall.points[currentWall.points.length - 1];
      const cur = ptToUnits(clientX, clientY);
      preview.setAttribute('points', [last, cur].map(p => `${toPx(p.x)},${toPx(p.y)}`).join(' '));
    };

    const onMove = (e) => updatePreview(e.clientX, e.clientY);
    const onClick = (e) => {
      currentWall.points.push(ptToUnits(e.clientX, e.clientY));
      updateProgress();
      updatePreview(e.clientX, e.clientY);
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
        dedupeWallsInState();          // ← AJOUT
        renderWalls();                 // rendu propre d’unique <polyline>
        await persistWalls();
      }
    };

    const cancel = () => teardown();
    const onKey = (e) => { if (e.key === 'Escape') cancel(); if (e.key === 'Enter') finish(); };
    const onDbl = () => finish();

    function teardown() {
      $stage.removeEventListener('click', onClick);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey);
      $stage.removeEventListener('dblclick', onDbl);
      progress.remove(); preview.remove();
      $stage.style.cursor = ''; document.body.classList.remove('pc_wall_mode');
    }

    $stage.addEventListener('click', onClick);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKey);
    $stage.addEventListener('dblclick', onDbl, { once: true });
  }


  // [8] ----------------------------------------------------------------------
  // Sélection multiple, clavier, alignements & répartitions
  // -------------------------------------------------------------------------

  function handleSelectableClick(e) {
    const node = e.currentTarget;
    if (e.shiftKey) {
      if (selection.has(node)) selection.delete(node); else selection.add(node);
      refreshSelectionStyling();
      selection.forEach(n => {
        n.dataset._startL = n.style.left;
        n.dataset._startT = n.style.top;
      });
      e.stopPropagation();
    } else {
      selection.clear(); selection.add(node);
      refreshSelectionStyling();
    }
  }

  function refreshSelectionStyling() {
    Array.from(selection).forEach(n => { if (!n.isConnected) selection.delete(n); });
    $stage.querySelectorAll('.pc_card, .pc_furn, #pc_svg .wall').forEach(n => {
      n.classList.toggle('pc_selected', selection.has(n));
    });
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
          // Snap spécial pour portes/fenêtres
          const t = (n.dataset.furnitureType || '').toLowerCase();
          if ((t === 'door' || t === 'window') && state.walls.length) {
            // on “centre” l’objet sur le mur le plus proche
            const center = { x: newX + (pxAdj.wEff / 2), y: newY + (pxAdj.hEff / 2) };
            const s = snapToNearestWall(center.x, center.y, 0.6);
            if (s) {
              const cx = snapUnits(s.x), cy = snapUnits(s.y);
              // recentre TL à partir du centre aimanté
              const nx = snapUnits(cx - (pxAdj.wEff / 2));
              const ny = snapUnits(cy - (pxAdj.hEff / 2));
              if (nx !== newX || ny !== newY) { movedFurn = true; }
              f.x = nx; f.y = ny;
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
      autosaveWalls(); // on persiste (debounce)…
      // …et c'est tout : PAS de renderWalls ici.
      refreshSelectionStyling(); // optionnel
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

  function alignSelection(side) {
    const nodes = Array.from(selection).filter(n => n.classList.contains('pc_card') || n.classList.contains('pc_furn'));
    if (nodes.length < 2) return;
    const rects = nodes.map(n => ({ n, L: parseFloat(n.style.left || '0'), T: parseFloat(n.style.top || '0'), W: parseFloat(n.style.width || '0'), H: parseFloat(n.style.height || '0') }));
    const minL = Math.min(...rects.map(r => r.L));
    const maxR = Math.max(...rects.map(r => r.L + r.W));
    const minT = Math.min(...rects.map(r => r.T));
    const maxB = Math.max(...rects.map(r => r.T + r.H));
    rects.forEach(r => {
      if (side === 'left') r.n.style.left = `${minL}px`;
      if (side === 'right') r.n.style.left = `${(maxR - r.W)}px`;
      if (side === 'top') r.n.style.top = `${minT}px`;
      if (side === 'bottom') r.n.style.top = `${(maxB - r.H)}px`;
    });
    nudgeSelection(0, 0);
  }
  function distributeSelection(orientation) {
    const nodes = Array.from(selection).filter(n => n.classList.contains('pc_card') || n.classList.contains('pc_furn'));
    if (nodes.length < 3) return;
    const rects = nodes.map(n => ({ n, L: parseFloat(n.style.left || '0'), T: parseFloat(n.style.top || '0'), W: parseFloat(n.style.width || '0'), H: parseFloat(n.style.height || '0') }));
    if (orientation === 'h') {
      rects.sort((a, b) => a.L - b.L);
      const minL = rects[0].L, maxR = Math.max(...rects.map(r => r.L + r.W));
      const totalW = rects.reduce((s, r) => s + r.W, 0);
      const gap = (maxR - minL - totalW) / (rects.length - 1);
      let cur = minL;
      rects.forEach((r, i) => { if (i === 0 || i === rects.length - 1) return; cur += rects[i - 1].W + gap; r.n.style.left = `${cur}px`; });
    } else {
      rects.sort((a, b) => a.T - b.T);
      const minT = rects[0].T, maxB = Math.max(...rects.map(r => r.T + r.H));
      const totalH = rects.reduce((s, r) => s + r.H, 0);
      const gap = (maxB - minT - totalH) / (rects.length - 1);
      let cur = minT;
      rects.forEach((r, i) => { if (i === 0 || i === rects.length - 1) return; cur += rects[i - 1].H + gap; r.n.style.top = `${cur}px`; });
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

    // --- murs
    if (el.tagName === 'polyline' && el.classList.contains('wall')) {
      const wallId = el.dataset.wallId;
      const before = state.walls.length;
      state.walls = state.walls.filter(w => String(w.id) !== String(wallId));
      el.remove();
      if (before !== state.walls.length) autosaveWalls();
      selection.delete(el);
      refreshSelectionStyling();
      return;
    }

    const typ = el.dataset.type;

    // --- élève
    if (typ === 'eleve') {
      const eleveId = parseInt(el.dataset.id, 10);
      api.deletePosition(state.active_plan.id, eleveId).then(() => {
        state.positions = state.positions.filter(p => p.eleve_id !== eleveId);
        el.remove();

        const e = state.eleves.find(x => x.id === eleveId);
        if (e && $elist) {
          const item = document.createElement('div');
          item.className = 'pc_eleve_item';
          item.dataset.eleveId = e.id;
          const img = document.createElement('img');
          img.src = PHOTOS_BASE + (e.photo_filename || 'default.jpg');
          const name = document.createElement('div');
          name.className = 'name';
          name.textContent = `${e.prenom} ${e.nom}`;
          item.append(img, name);
          item.addEventListener('pointerdown', startDragFromList);
          $elist.appendChild(item);
        }

        selection.delete(el);
        refreshSelectionStyling();
      }).catch(err => {
        console.error(err);
        alert("Suppression impossible (élève).");
      });
      return;
    }

    // --- meuble
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
          const rot = Number(f.rotation || 0);

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
      restoreWallsForPlan();

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

  // --- Helper: ID de plan courant fiable (évite "0")
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

  // suppression de plan (optionnel via SEATING_URLS.deletePlan)
  $delPlan?.addEventListener('click', async () => {
    const planId = currentPlanIdSafe();
    if (!planId) { alert("Aucun plan valide sélectionné."); return; }

    const name = $sel?.selectedOptions?.[0]?.text || `Plan ${planId}`;
    if (!confirm(`Supprimer le plan « ${name} » ?\nCette action est irréversible.`)) return;

    console.log('[pc] delete plan id =', planId, 'url=', window.SEATING_URLS?.deletePlan?.(planId));
    const ok = await api.deletePlan(planId);
    if (!ok) { alert("Suppression côté serveur non confirmée."); return; }

    await boot(); // recharge depuis le serveur
    if ($sel && state.active_plan) {
      $sel.value = String(state.active_plan.id);
      $sel.dispatchEvent(new Event('change'));
    }
  });


  // Clavier global : suppression, déplacements, alignements, distributions
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
      let stepPx = 1;
      if (e.shiftKey) stepPx = 10;
      if (e.altKey) stepPx = Math.max(1, Math.round(unitPx / UI_SUBDIV));
      const dx = (e.key === 'ArrowLeft' ? -stepPx : e.key === 'ArrowRight' ? stepPx : 0);
      const dy = (e.key === 'ArrowUp' ? -stepPx : e.key === 'ArrowDown' ? stepPx : 0);
      nudgeSelection(dx, dy);
      e.preventDefault(); return;
    }

    if (ctrlAlt) {
      if (e.key === 'ArrowLeft') { alignSelection('left'); e.preventDefault(); }
      if (e.key === 'ArrowRight') { alignSelection('right'); e.preventDefault(); }
      if (e.key === 'ArrowUp') { alignSelection('top'); e.preventDefault(); }
      if (e.key === 'ArrowDown') { alignSelection('bottom'); e.preventDefault(); }
      if (e.key?.toLowerCase() === 'h') { distributeSelection('h'); e.preventDefault(); }
      if (e.key?.toLowerCase() === 'v') { distributeSelection('v'); e.preventDefault(); }
    }
  });

  // Resize
  window.addEventListener('resize', () => render());

  // init
  boot().catch(console.error);
  setupFullscreenExact($wrap, fitStageToWrap, render);

})();
