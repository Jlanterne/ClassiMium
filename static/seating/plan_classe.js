/* ============================================================================
   plan_classe.js — ÉDITEUR DE PLAN DE CLASSE
   ============================================================================

   SOMMAIRE
   --------
   [0]  Bootstrap & Constants
   [1]  Utilities (unités/px, géométrie, couleurs, localStorage)
   [2]  API client (fetch)
   [3]  Autosave (positions, meubles) & resync contrôlé
   [4]  Stage fit + Grille
   [5]  Collisions & "collapse" (aimantation bord à bord)
   [6]  Rendu: élèves, meubles, murs (SVG), palette
   [7]  Drag & Drop:
        7.1 Élève depuis la liste (ghost final)
        7.2 Déplacement carte élève
        7.3 Création meuble depuis palette (ghost final)
        7.4 Déplacement / redimension meuble (4 coins) + rotation
        7.5 Tracé de murs (polyline SVG)
   [8]  Sélection multiple, clavier, alignements & répartitions
   [9]  Suppression (élève / meuble), édition couleur & coins arrondis
   [10] Boot (chargement, mapping id temp -> id serveur, persistance couleurs)
   [11] Listeners globaux (resize/keypress) & init

   Points clés
   ----------
   • Couleur PAR MEUBLE => sauvegarde immédiate unitaire ; boot() n’écrase pas.
   • Anti-duplication => Set(uid) lors des PUT, mapping client_uid sur boot.
   • Murs en SVG (hachures) ; portes/fenêtres -> placement forcé sur mur.
   • Fantômes (élèves/meubles) identiques à l’objet final pendant le drag.
   • Sélection multiple + déplacements clavier + alignements/distrib à la Word.
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

  let UI_SUBDIV = 32;      // précision UI
  let PLAN_SUBDIV = 32;    // précision stockage API
  let unitPx = 32;         // dimension d'une unité en pixels (calculée par autofit)

  // ids temporaires (meubles) & mode édition
  let tempIdSeq = -1;
  let editMode = false;

  // anti-duplications autosave (nouveaux meubles)
  const sentNewFurniture = new Set(); // uid client déjà envoyé durant un debounce

  // état global unifié
  let state = {
    plans: [],
    active_plan: null,
    furniture: [],
    positions: [],
    walls: [],          // [{ id, points:[{x,y}...]}]
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
  const $full = document.getElementById('pc_fullscreen');
  const $elist = document.getElementById('pc_eleve_list');
  const $wrap = $stage.parentElement;
  const $reset = document.getElementById('pc_reset_plan');
  const $palette = document.getElementById('pc_furn_palette');
  const $edit = document.getElementById('pc_edit_mode');

  const $subdiv = document.getElementById('pc_subdiv');
  try { $subdiv?.closest('label')?.style && ($subdiv.closest('label').style.display = 'none'); } catch { }

  // conteneur SVG (murs)
  let $svg = null;

  // [1] ----------------------------------------------------------------------
  // Utilities : unités/px, géométrie, couleurs, localStorage
  // -------------------------------------------------------------------------

  const EPS = 1e-6;
  const TICK = 1 / UI_SUBDIV;          // “pas” d'aimantation
  const DRAG_THRESHOLD = 6;            // px (distinction clic / drag)

  const toPx = u => u * unitPx;
  const fromPxU = px => px / unitPx;
  const snapUnits = v => Math.round(v * UI_SUBDIV) / UI_SUBDIV;

  const genUid = () => 'f_' + Math.random().toString(36).slice(2, 10);

  // ====== MURS : dessin en polyligne sur un calque SVG ======
  (function () {
    const stage = document.getElementById('pc_stage');
    const svg = document.getElementById('pc_svg');
    if (!stage || !svg) return;

    // état local du mode dessin
    const draw = {
      mode: null,         // 'wall' | null
      wall: null,         // { id, type:'wall', points:[{x,y}], color, width }
      previewEl: null
    };

    const grid = (window.SEATING_CONF && +window.SEATING_CONF.grid) || +stage.dataset.grid || 32;

    // ===== Helpers
    function createSvg(tag, attrs) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const k in attrs) el.setAttribute(k, attrs[k]);
      return el;
    }
    function snap(v, step) { return Math.round(v / step) * step; }
    function clientToStage(e) {
      const r = stage.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      return { x: snap(x, grid), y: snap(y, grid) };
    }
    function pointsAttr(points) { return points.map(p => `${p.x},${p.y}`).join(' '); }
    function updatePreview(extraPt) {
      if (!draw.previewEl || !draw.wall) return;
      const pts = extraPt ? [...draw.wall.points, extraPt] : draw.wall.points;
      draw.previewEl.setAttribute('points', pointsAttr(pts));
    }
    function cleanupPreview() {
      if (draw.previewEl) { draw.previewEl.remove(); draw.previewEl = null; }
    }
    function enableWallMode(on = true) {
      draw.mode = on ? 'wall' : null;
      if (!on) { draw.wall = null; cleanupPreview(); }
      document.body.classList.toggle('pc_edit_on', !!on); // visuel facultatif
    }

    // ===== Persistance (branche sur ton système existant)
    function saveWallToState(wall) {
      // On utilise le même tableau que les meubles si présent
      // Adapte le nom si nécessaire (state.furniture / state.meubles / etc.)
      window._SEATING_STATE = window._SEATING_STATE || {};
      const s = window._SEATING_STATE;
      s.furniture = s.furniture || [];
      s.furniture.push(wall);

      // Si tu as déjà une fonction d’upsert côté API, appelle-la ici :
      // fetch(SEATING_URLS.upsertFurniture(planId), { method:'POST', body: JSON.stringify([...]) })
    }

    // ===== Rendu initial (murs existants)
    function renderExistingWalls() {
      const s = window._SEATING_STATE;
      if (!s || !Array.isArray(s.furniture)) return;
      s.furniture.filter(it => it.type === 'wall').forEach(wall => {
        const el = createSvg('polyline', {
          class: 'wall',
          'data-id': wall.id,
          points: pointsAttr(wall.points)
        });
        svg.appendChild(el);
      });
    }
    renderExistingWalls();

    // ===== Événements
    stage.addEventListener('click', (e) => {
      if (draw.mode !== 'wall') return;
      const pt = clientToStage(e);
      if (!draw.wall) {
        // premier point → créer la prévisualisation
        draw.wall = {
          id: 'wall_' + Math.random().toString(36).slice(2, 9),
          type: 'wall',
          points: [pt],
          color: '#111827',
          width: 4
        };
        draw.previewEl = createSvg('polyline', { class: 'wall-preview', points: `${pt.x},${pt.y}` });
        svg.appendChild(draw.previewEl);
      } else {
        draw.wall.points.push(pt);
        updatePreview();
      }
    });

    stage.addEventListener('mousemove', (e) => {
      if (draw.mode !== 'wall' || !draw.wall) return;
      const pt = clientToStage(e);
      updatePreview(pt);
    });

    stage.addEventListener('dblclick', finalizeWall);
    document.addEventListener('keydown', (e) => {
      if (draw.mode !== 'wall') {
        // Raccourci clavier pour démarrer le mode mur : Shift+W
        if (e.shiftKey && (e.key === 'w' || e.key === 'W')) enableWallMode(true);
        return;
      }
      if (e.key === 'Escape') {
        enableWallMode(false);
      } else if (e.key === 'Enter') {
        finalizeWall(e);
      } else if (e.key === 'Backspace') {
        if (draw.wall && draw.wall.points.length > 0) {
          draw.wall.points.pop();
          updatePreview();
          e.preventDefault();
        }
      }
    });

    function finalizeWall(e) {
      if (draw.mode !== 'wall' || !draw.wall) return;
      // besoin d'au moins 2 segments (3 points) ou 2 points si on accepte un seul segment
      if (draw.wall.points.length < 2) { enableWallMode(false); return; }

      // créer la polyligne définitive
      const el = createSvg('polyline', {
        class: 'wall',
        'data-id': draw.wall.id,
        points: pointsAttr(draw.wall.points)
      });
      svg.appendChild(el);

      // persister dans l’état / API
      saveWallToState(draw.wall);

      // reset mode
      enableWallMode(false);
    }

    // ===== (Optionnel) Bouton si tu veux un déclencheur visuel
    // Si tu rajoutes un bouton <button id="pc_draw_wall">Tracer un mur</button> dans la palette
    const btn = document.getElementById('pc_draw_wall');
    if (btn) btn.addEventListener('click', () => enableWallMode(true));
  })();

  // ===== Reset des MURS quand on clique sur "Réinitialiser" =====
  (function () {
    const stage = document.getElementById('pc_stage');
    const svg = document.getElementById('pc_svg'); // calque SVG (ajouté pour tracer les murs)
    const btnReset = document.getElementById('pc_reset_plan');

    if (!stage || !btnReset) return;

    // Récupère l'id du plan actif, en restant tolérant
    function getActivePlanId() {
      // 1) via select si présent
      const sel = document.getElementById('pc_plan_select');
      if (sel && sel.value) return +sel.value;

      // 2) via un état global si tu en as un
      if (window._SEATING_STATE && window._SEATING_STATE.active_plan) {
        return +window._SEATING_STATE.active_plan;
      }
      // 3) fallback nul → l’API sera simplement sautée
      return null;
    }

    function removeAllWallsFromSVG() {
      if (!svg) return;
      svg.querySelectorAll('.wall, .wall-preview').forEach(el => el.remove());
    }

    function removeWallsFromState() {
      // Harmonise avec ta structure d’état
      // Si ton JS utilise un autre nom que _SEATING_STATE, adapte ici.
      const S = (window._SEATING_STATE = window._SEATING_STATE || {});
      S.furniture = Array.isArray(S.furniture) ? S.furniture.filter(it => it?.type !== 'wall') : [];
    }

    async function pushFurnitureToAPI() {
      if (!window.SEATING_URLS || typeof window.SEATING_URLS.upsertFurniture !== 'function') return;
      const planId = getActivePlanId();
      if (!planId) return;

      const S = window._SEATING_STATE || {};
      const payload = Array.isArray(S.furniture) ? S.furniture : [];

      try {
        await fetch(window.SEATING_URLS.upsertFurniture(planId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (err) {
        console.warn('Échec upsertFurniture (reset murs) :', err);
      }
    }

    // Fonction publique au cas où tu veux l’appeler depuis ton reset global existant
    async function resetWallsOnly() {
      removeAllWallsFromSVG();
      removeWallsFromState();
      await pushFurnitureToAPI();
    }

    // On évite d’attacher plusieurs fois si ce fichier est rechargé
    if (!btnReset.dataset.wallResetBound) {
      btnReset.addEventListener('click', async (e) => {
        // Si tu as déjà un “reset complet” côté JS, ce patch ne le remplace pas :
        // il s’assure juste que les MURS sont reset aussi.
        // On peut aussi distinguer clic normal vs Shift+clic si tu le veux :
        // const full = e.shiftKey; // (non utilisé ici)
        await resetWallsOnly();
      });
      btnReset.dataset.wallResetBound = '1';
    }

    // Rends la fonction accessible si tu veux l’appeler dans TON handler existant
    window.resetWallsOnly = resetWallsOnly;
  })();




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

  function footprintCardUnits() {
    const units = Math.ceil((96 / unitPx) * UI_SUBDIV) / UI_SUBDIV;
    const u = Math.max(TICK, units);
    return { w: u, h: u };
  }

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

  // localStorage: couleur par plan+meuble (fallback si API omet la couleur)
  const colorKey = (pid, id) => `pc_color_${pid}_${id}`;
  const lsGetColor = (pid, id) => { try { return localStorage.getItem(colorKey(pid, id)); } catch { return null; } };
  const lsSetColor = (pid, id, val) => { try { localStorage.setItem(colorKey(pid, id), val); } catch { } };
  const lsDelColor = (pid, id) => { try { localStorage.removeItem(colorKey(pid, id)); } catch { } };

  // [2] ----------------------------------------------------------------------
  // API Client
  // -------------------------------------------------------------------------

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
    // (optionnel) murs si tu exposes l’API
    saveWalls: (plan_id, walls) => fetch(`${API_BASE}/plans/${plan_id}/walls`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walls }) }).then(r => r.json())
  };

  // [3] ----------------------------------------------------------------------
  // Autosave (debounce) & resync contrôlé
  // -------------------------------------------------------------------------

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
  }, 500);

  const autosaveFurniture = debounce(() => {
    if (!state.active_plan) return;
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
        z: f.z || 0,
        radius: !!f.radius
      }));
    if (!payload.length) return;

    const justSentUids = new Set(payload.filter(p => !p.id && p.client_uid).map(p => p.client_uid));
    justSentUids.forEach(uid => sentNewFurniture.add(uid));

    api.saveFurniture(state.active_plan.id, payload).catch(err => {
      console.error(err);
      justSentUids.forEach(uid => sentNewFurniture.delete(uid));
    });
  }, 500);

  // Sauvegarde immédiate, un meuble, PAS de boot() (pour ne pas écraser la couleur locale)
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
      rotation: Math.round((f.rotAbs ?? f.rotation ?? 0) % 360),
      z: f.z || 0,
      radius: !!f.radius
    }];
    try { await api.saveFurniture(state.active_plan.id, payload); } catch (e) { console.error(e); }
  }

  let resyncTimer = null;
  function resyncSoon(delay = 600) {
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(() => boot().catch(console.error), delay);
  }

  // [4] ----------------------------------------------------------------------
  // Stage fit + Grille de fond
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

    // SVG overlay (murs)
    if (!$svg) {
      $svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      $svg.setAttribute('class', 'pc_svg_overlay');
      $svg.style.position = 'absolute';
      $svg.style.left = '0'; $svg.style.top = '0'; $svg.style.width = '100%'; $svg.style.height = '100%';
      $svg.style.pointerEvents = 'none';
      $stage.appendChild($svg);
      ensureHatchPattern();
    }
  }

  function ensureHatchPattern() {
    if (!$svg) return;
    let defs = $svg.querySelector('defs');
    if (!defs) { defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs'); $svg.appendChild(defs); }
    if ($svg.querySelector('#hatch')) return;
    const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
    pattern.setAttribute('id', 'hatch'); pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    pattern.setAttribute('width', '8'); pattern.setAttribute('height', '8');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M-2,2 l4,-4 M0,8 l8,-8 M6,10 l4,-4');
    path.setAttribute('stroke', '#334155'); path.setAttribute('stroke-width', '1');
    defs.appendChild(pattern); pattern.appendChild(path);
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

  const notOverlap = (a, b) =>
    (a.x + a.w) <= b.x + EPS || (b.x + b.w) <= a.x + EPS ||
    (a.y + a.h) <= b.y + EPS || (b.y + b.h) <= a.y + EPS;
  const collides = (r, others) => others.some(o => !notOverlap(r, o));

  function snapCollapse(r, others) {
    const margin = TICK + 1e-9;
    const overlap1D = (a0, a1, b0, b1) => !(a1 <= b0 + EPS || b1 <= a0 + EPS);
    let best = null;
    for (const o of others) {
      if (overlap1D(r.y, r.y + r.h, o.y, o.y + o.h)) {
        const dx1 = o.x - (r.x + r.w);      // droite r -> gauche o
        const dx2 = (o.x + o.w) - r.x;      // gauche r <- droite o
        if (Math.abs(dx1) <= margin) best = chooseBest(best, { dx: dx1, dy: 0 });
        if (Math.abs(dx2) <= margin) best = chooseBest(best, { dx: dx2, dy: 0 });
      }
      if (overlap1D(r.x, r.x + r.w, o.x, o.x + o.w)) {
        const dy1 = o.y - (r.y + r.h);      // bas r -> haut o
        const dy2 = (o.y + o.h) - r.y;      // haut r <- bas o
        if (Math.abs(dy1) <= margin) best = chooseBest(best, { dx: 0, dy: dy1 });
        if (Math.abs(dy2) <= margin) best = chooseBest(best, { dx: 0, dy: dy2 });
      }
    }
    if (!best) return r;
    const cand = { x: snapUnits(r.x + best.dx), y: snapUnits(r.y + best.dy), w: r.w, h: r.h };
    const c = clampToStage(cand.x, cand.y, r.w, r.h);
    const snapped = { x: c.gx, y: c.gy, w: r.w, h: r.h };
    return collides(snapped, others) ? r : snapped;

    function chooseBest(cur, nxt) {
      if (!cur) return nxt;
      const cd = Math.abs(cur.dx) + Math.abs(cur.dy);
      const nd = Math.abs(nxt.dx) + Math.abs(nxt.dy);
      return (nd < cd) ? nxt : cur;
    }
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
    if ($svg) $svg.innerHTML = '<defs></defs>'; ensureHatchPattern();
  }

  function moyClass(m20) { if (m20 == null) return ''; if (m20 >= 16) return 'mAp'; if (m20 >= 13) return 'mA'; if (m20 >= 8) return 'mPA'; return 'mNA'; }

  // -- élèves
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
    btn.className = 'pc_delete_btn'; btn.style.right = '26px';
    btn.title = 'Pivoter (90°) — Alt+molette: rotation fine'; btn.textContent = '↻';
    btn.addEventListener('click', (e) => { e.stopPropagation(); setCardRotation(card, 90); });
    card.addEventListener('wheel', (e) => { if (!e.altKey) return; e.preventDefault(); setCardRotation(card, (e.deltaY > 0 ? -5 : 5)); }, { passive: false });
    card.appendChild(btn);
  }
  function addCard(eleve, pos) {
    const card = document.createElement('div');
    card.className = 'pc_card'; card.dataset.type = 'eleve';
    card.dataset.id = eleve.id; card.dataset.eleveId = eleve.id;
    if (eleve.sexe) card.dataset.sexe = eleve.sexe;
    if (eleve.niveau) card.dataset.niveau = eleve.niveau;
    card.dataset.prenom = eleve.prenom || '';
    if (pos.rot != null) { card.dataset.rot = String(pos.rot); card.dataset.rotAbs = String(pos.rot); }

    card.style.left = `${toPx(pos.x)}px`; card.style.top = `${toPx(pos.y)}px`;
    card.title = `${eleve.prenom || ''} ${eleve.nom || ''}`;

    const inner = document.createElement('div'); inner.className = 'pc_card_in';
    inner.style.transform = `rotate(${card.dataset.rotAbs || card.dataset.rot || 0}deg)`;

    const img = document.createElement('img');
    img.src = PHOTOS_BASE + (eleve.photo_filename || 'default.jpg');
    img.draggable = card.draggable = false;
    img.addEventListener('dragstart', ev => ev.preventDefault());
    card.addEventListener('dragstart', ev => ev.preventDefault());

    const name = document.createElement('div'); name.className = 'pc_name_in'; name.textContent = eleve.prenom || '';
    {
      const abs = parseFloat(card.dataset.rotAbs || '0') || 0; const d = ((abs % 360) + 360) % 360;
      name.style.transform = (d > 135 && d < 225) ? 'rotate(180deg)' : 'rotate(0deg)';
    }

    const bSex = document.createElement('div'); bSex.className = 'badge sex';
    bSex.textContent = (eleve.sexe === 'MASCULIN' ? '♂' : eleve.sexe === 'FEMININ' ? '♀' : '?');

    const bM = document.createElement('div'); bM.className = `badge moy ${moyClass(eleve.moyenne_20)}`;
    bM.textContent = (eleve.moyenne_20 != null) ? Math.round(eleve.moyenne_20) : '—';

    inner.append(img, name);
    card.append(inner, bSex, bM);
    addDeleteButton(card);
    addRotateButton(card);
    card.addEventListener('pointerdown', startDragCard);

    // sélection (MAJ+clic)
    card.addEventListener('click', handleSelectableClick);
    $stage.appendChild(card);
  }

  // -- meubles
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
    btn.className = 'pc_delete_btn'; btn.style.right = '26px'; btn.title = 'Pivoter (90°) — Alt+molette: rotation fine'; btn.textContent = '↻';
    btn.addEventListener('click', (e) => { e.stopPropagation(); setFurnitureRotation(el, 90); });
    el.addEventListener('wheel', (e) => { if (!e.altKey) return; e.preventDefault(); setFurnitureRotation(el, (e.deltaY > 0 ? -5 : 5)); }, { passive: false });
    el.appendChild(btn);
  }
  function addFurnCornerToggle(el) {
    if (el.dataset.furnitureType === 'table_round') return; // déjà rond
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
    // affichage conditionné au mode édition
    btn.style.display = editMode ? 'block' : 'none';
  }
  function setFurnitureRotation(el, delta) {
    const abs = (parseFloat(el.dataset.rotAbs || el.dataset.rot || '0') || 0) + delta;
    el.dataset.rotAbs = String(abs);
    el.style.transform = `rotate(${abs}deg)`;
    const id = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
    const f = (id != null) ? state.furniture.find(x => x.id === id) : null;
    if (f) { f.rotAbs = abs; f.rotation = abs % 360; autosaveFurniture(); }
  }
  function addFurnitureColorBtn(el) {
    const id = el.dataset.id ? parseInt(el.dataset.id, 10) : null;
    const f = (id != null) ? state.furniture.find(x => x.id === id) : null;

    let pick = el.querySelector('.pc_col_btn');
    if (!pick) {
      pick = document.createElement('input');
      pick.type = 'color'; pick.className = 'pc_col_btn';
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
    // copie visuelle proche de la carte finale (sans badges pour légèreté)
    const ghost = document.createElement('div');
    ghost.className = 'pc_card';
    ghost.style.position = 'fixed'; ghost.style.pointerEvents = 'none'; ghost.style.opacity = '0.8'; ghost.style.zIndex = '9999';
    ghost.style.width = '96px'; ghost.style.height = '96px';
    const inner = document.createElement('div'); inner.className = 'pc_card_in';
    const img = document.createElement('img'); img.src = PHOTOS_BASE + (eleve.photo_filename || 'default.jpg');
    const name = document.createElement('div'); name.className = 'pc_name_in'; name.textContent = eleve.prenom || '';
    inner.append(img, name); ghost.append(inner);
    return ghost;
  }
  function makeFurnitureGhost(type, wUnits, hUnits) {
    const t = (type || 'autre').toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/\s+/g, '_');
    const ghost = document.createElement('div');
    ghost.className = `pc_furn preview type-${t}`;
    ghost.style.position = 'fixed'; ghost.style.pointerEvents = 'none'; ghost.style.opacity = '0.75'; ghost.style.zIndex = '9999';
    ghost.style.width = `${toPx(wUnits)}px`; ghost.style.height = `${toPx(hUnits)}px`;
    ghost.style.transformOrigin = 'center center'; ghost.style.borderStyle = 'dashed';
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
      el.className = 'pc_furn'; el.dataset.type = 'furniture';
      el.dataset.id = (f.id != null) ? String(f.id) : '';
      const t = (f.type || 'autre').toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/\s+/g, '_');
      el.dataset.furnitureType = t; el.classList.add(`type-${t}`);
      if (f.rotation != null) el.dataset.rot = String(f.rotation);
      if (f.rotAbs != null) el.dataset.rotAbs = String(f.rotAbs);
      el.style.left = `${toPx(f.x)}px`; el.style.top = `${toPx(f.y)}px`;
      el.style.width = `${toPx(f.w)}px`; el.style.height = `${toPx(f.h)}px`;
      el.style.transformOrigin = 'center center';
      el.style.transform = `rotate(${el.dataset.rotAbs || el.dataset.rot || 0}deg)`;
      if (f.radius) el.style.borderRadius = '12px';
      const color = f.color || FURN_COLORS[t] || null; if (color) applyFurnitureColor(el, t, color);

      const label = document.createElement('div'); label.className = 'label'; label.textContent = f.label || f.type || 'meuble';

      const makeHandle = dir => { const h = document.createElement('div'); h.className = `rz ${dir}`; h.dataset.dir = dir; h.title = 'Redimensionner'; h.addEventListener('pointerdown', startResizeFurniture); return h; };

      el.append(label, makeHandle('nw'), makeHandle('ne'), makeHandle('se'), makeHandle('sw'));
      addDeleteButton(el); addFurnRotate(el); addFurnCornerToggle(el);
      el.addEventListener('pointerdown', startDragFurniture);
      // sélection multiple
      el.addEventListener('click', handleSelectableClick);
      $stage.appendChild(el);

      // handles visibles si édition
      el.querySelectorAll('.rz').forEach(h => {
        h.style.pointerEvents = editMode ? 'auto' : 'none';
        h.style.opacity = editMode ? '1' : '0';
      });
      if (editMode) addFurnitureColorBtn(el);
    }
  }

  function renderWalls() {
    if (!$svg) return;
    // murs = polylines hachurées
    for (const w of state.walls) {
      if (!w.points || w.points.length < 2) continue;
      const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      pl.setAttribute('fill', 'none');
      pl.setAttribute('stroke', 'url(#hatch)');
      pl.setAttribute('stroke-width', Math.max(3, unitPx * 0.12));
      const pts = w.points.map(p => `${toPx(p.x)},${toPx(p.y)}`).join(' ');
      pl.setAttribute('points', pts);
      $svg.appendChild(pl);
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

  function render() {
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
    refreshSelectionStyling();
  }

  // palette meubles + “Mur (tracer)”
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

    // Item: Tracer un mur
    const wallItem = document.createElement('div');
    wallItem.className = 'pc_furn_tpl wall_tool';
    wallItem.innerHTML = `
      <div class="thumb wall"></div>
      <div class="info"><div class="name">Mur (tracer)</div><div class="dims">clics successifs</div></div>
    `;
    wallItem.addEventListener('pointerdown', startWallTool);
    $palette.appendChild(wallItem);

    // Items meubles
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
      item.addEventListener('pointerdown', (ev) => startCreateFurnitureDrag(ev, d));
      const cp = item.querySelector('.colpick');
      cp.addEventListener('input', () => {
        FURN_COLORS[d.type] = cp.value;
        const thumb = item.querySelector('.thumb');
        if (thumb) { thumb.style.background = cp.value; thumb.style.borderColor = cp.value; }
      });
      $palette.appendChild(item);
    });
    $palette.dataset.built = '1';
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

  // 7.2 Déplacement carte élève
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
      if (p) { p.x = spot.x; p.y = spot.y; }
      else { state.positions.push({ eleve_id: dragData.eleveId, x: spot.x, y: spot.y, seat_id: null, rot: 0, rotAbs: 0 }); }
      autosavePositions();
    } else shake(card);

    dragData = null; render();
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

      // Portes / fenêtres : doivent coller à un mur
      const isOnWallType = (def.type === 'door' || def.type === 'window');
      let drop = clientToUnitsClamped(e.clientX, e.clientY, wEff, hEff);
      if (isOnWallType && state.walls.length) {
        const snapped = snapToNearestWall(drop.x, drop.y);
        if (!snapped) { alert("Placez portes/fenêtres sur un mur."); return; }
        drop = { x: snapped.x, y: snapped.y };
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
      resyncSoon(500); // obtenir rapidement l'id serveur, sans écraser les couleurs locales
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
    // si sélection multiple => déplacer tout le groupe
    if (selection.has(el)) {
      const dx = (ev.clientX - dragData.sx), dy = (ev.clientY - dragData.sy);
      selection.forEach(node => {
        const sL = parseFloat(node.dataset._startL || node.style.left || '0');
        const sT = parseFloat(node.dataset._startT || node.style.top || '0');
        node.style.left = (sL + dx) + 'px';
        node.style.top = (sT + dy) + 'px';
      });
    } else {
      el.style.left = (dragData.startLeft + (ev.clientX - dragData.sx)) + 'px';
      el.style.top = (dragData.startTop + (ev.clientY - dragData.sy)) + 'px';
    }
  }
  function endDragFurniture(ev) {
    const el = ev.currentTarget;
    el.releasePointerCapture(ev.pointerId);
    el.removeEventListener('pointermove', onDragFurnitureMove);

    // group or single
    const nodes = selection.has(el) ? Array.from(selection) : [el];

    nodes.forEach(node => {
      const L = parseFloat(node.style.left || '0');
      const T = parseFloat(node.style.top || '0');
      const W = parseFloat(node.style.width || '0');
      const H = parseFloat(node.style.height || '0');
      const gw = Math.max(TICK, Math.ceil((W / unitPx) * UI_SUBDIV) / UI_SUBDIV);
      const gh = Math.max(TICK, Math.ceil((H / unitPx) * UI_SUBDIV) / UI_SUBDIV);
      const rotNow = parseFloat(node.dataset.rotAbs || node.dataset.rot || '0') || 0;
      const swapNow = isQuarterTurnSwap(rotNow), wEff = swapNow ? gh : gw, hEff = swapNow ? gw : gh;

      const box = stageInnerBox();
      const { x: gx, y: gy } = clientToUnitsClamped(box.left + L, box.top + T, wEff, hEff);
      const id = node.dataset.id ? parseInt(node.dataset.id, 10) : null;
      const fRef = (id != null) ? state.furniture.find(x => x.id === id) : null;

      let spot = findNearestFreeSpot(gx, gy, wEff, hEff, { furnitureId: id ?? -1 });
      if (!spot) { shake(node); return; }
      spot = snapCollapse(spot, rectsInPlan({ furnitureId: id ?? -1 }));

      if (fRef) { fRef.x = spot.x; fRef.y = spot.y; fRef.w = gw; fRef.h = gh; }
    });

    autosaveFurniture();
    dragData = null;
    render();
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
    if (!spot) { shake(el); dragData = null; render(); return; }
    spot = snapCollapse(spot, rectsInPlan({ furnitureId: id ?? -1 }));

    const f = (id != null) ? state.furniture.find(x => x.id === id) : null;
    if (f) { f.w = gw; f.h = gh; f.x = spot.x; f.y = spot.y; }

    autosaveFurniture();
    dragData = null; render();
  }

  // 7.5 Tracé des murs (SVG)
  let wallToolActive = false;
  let currentWall = null;

  function startWallTool(ev) {
    ev.preventDefault();
    wallToolActive = true;
    currentWall = { id: genUid(), points: [] };
    $stage.style.cursor = 'crosshair';

    const onStageClick = (e) => {
      const box = stageInnerBox();
      const x = snapUnits((e.clientX - box.left) / unitPx);
      const y = snapUnits((e.clientY - box.top) / unitPx);
      currentWall.points.push({ x, y });
      render(); // montre la polyline en cours (2 points min pour voir qqch)
    };
    const onKey = (e) => {
      if (!wallToolActive) return;
      if (e.key === 'Escape') {
        wallToolActive = false; currentWall = null;
        $stage.removeEventListener('click', onStageClick);
        window.removeEventListener('keydown', onKey);
        $stage.style.cursor = '';
        render();
      }
      if (e.key === 'Enter') {
        finishWall();
      }
    };
    const finishWall = () => {
      if (currentWall && currentWall.points.length >= 2) {
        state.walls.push(currentWall);
        // (optionnel) persist
        try { api.saveWalls?.(state.active_plan.id, state.walls).catch(() => { }); } catch { }
      }
      wallToolActive = false; currentWall = null;
      $stage.removeEventListener('click', onStageClick);
      window.removeEventListener('keydown', onKey);
      $stage.style.cursor = '';
      render();
    };

    $stage.addEventListener('click', onStageClick);
    window.addEventListener('keydown', onKey);
    // double-clic = terminer
    const onDbl = () => { /* simul Enter */ const evKey = new KeyboardEvent('keydown', { key: 'Enter' }); window.dispatchEvent(evKey); };
    $stage.addEventListener('dblclick', onDbl, { once: true });
  }

  // Snap point (x,y) sur le segment de mur le plus proche (seuil 0.5u)
  function snapToNearestWall(x, y) {
    if (!state.walls.length) return null;
    let best = null, bestD = Infinity;
    for (const w of state.walls) {
      for (let i = 0; i < w.points.length - 1; i++) {
        const a = w.points[i], b = w.points[i + 1];
        const proj = projectPointOnSegment({ x, y }, a, b);
        if (!proj) continue;
        const d = Math.hypot(proj.x - x, proj.y - y);
        if (d < bestD) { bestD = d; best = proj; }
      }
    }
    if (bestD <= 0.5) return best; // à ≤ 0.5 unité
    return null;
  }
  function projectPointOnSegment(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const ab2 = abx * abx + aby * aby; if (ab2 < EPS) return null;
    const apx = p.x - a.x, apy = p.y - a.y;
    let t = (apx * abx + apy * aby) / ab2; t = Math.max(0, Math.min(1, t));
    return { x: a.x + t * abx, y: a.y + t * aby };
  }

  // [8] ----------------------------------------------------------------------
  // Sélection multiple, clavier, alignements & répartitions
  // -------------------------------------------------------------------------

  // Set des éléments sélectionnés (DOM nodes .pc_card / .pc_furn)
  const selection = new Set();

  function handleSelectableClick(e) {
    const node = e.currentTarget;
    if (e.shiftKey) {
      // toggle
      if (selection.has(node)) selection.delete(node); else selection.add(node);
      refreshSelectionStyling();
      // memorise positions de départ pour drag groupé
      selection.forEach(n => {
        n.dataset._startL = n.style.left;
        n.dataset._startT = n.style.top;
      });
      e.stopPropagation();
    } else {
      // sélection simple
      selection.clear(); selection.add(node);
      refreshSelectionStyling();
    }
  }
  function refreshSelectionStyling() {
    $stage.querySelectorAll('.pc_card, .pc_furn').forEach(n => {
      n.classList.toggle('pc_selected', selection.has(n));
    });
  }

  function nudgeSelection(dxPx, dyPx) {
    if (!selection.size) return;
    selection.forEach(n => {
      const L = parseFloat(n.style.left || '0');
      const T = parseFloat(n.style.top || '0');
      n.style.left = (L + dxPx) + 'px';
      n.style.top = (T + dyPx) + 'px';
      // commit en unités
      if (n.classList.contains('pc_card')) {
        const id = parseInt(n.dataset.eleveId, 10);
        const fp = footprintCardUnits();
        const box = stageInnerBox();
        const { x: gx, y: gy } = clientToUnitsClamped(box.left + L + dxPx, box.top + T + dyPx, fp.w, fp.h);
        const p = state.positions.find(p => p.eleve_id === id);
        if (p) { p.x = gx; p.y = gy; }
      } else {
        const id = parseInt(n.dataset.id, 10);
        const f = state.furniture.find(x => x.id === id);
        if (f) {
          const W = parseFloat(n.style.width || '0'), H = parseFloat(n.style.height || '0');
          const gw = Math.max(TICK, Math.ceil((W / unitPx) * UI_SUBDIV) / UI_SUBDIV);
          const gh = Math.max(TICK, Math.ceil((H / unitPx) * UI_SUBDIV) / UI_SUBDIV);
          const rotNow = parseFloat(n.dataset.rotAbs || n.dataset.rot || '0') || 0;
          const swapNow = isQuarterTurnSwap(rotNow);
          const wEff = swapNow ? gh : gw, hEff = swapNow ? gw : gh;
          const box = stageInnerBox();
          const { x: gx, y: gy } = clientToUnitsClamped(box.left + L + dxPx, box.top + T + dyPx, wEff, hEff);
          f.x = gx; f.y = gy; f.w = gw; f.h = gh;
        }
      }
    });
    autosavePositions(); autosaveFurniture();
  }

  function alignSelection(side) { // 'left'|'right'|'top'|'bottom'
    if (selection.size < 2) return;
    const nodes = Array.from(selection);
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
    // commit
    nudgeSelection(0, 0);
  }
  function distributeSelection(orientation) { // 'h'|'v'
    if (selection.size < 3) return;
    const nodes = Array.from(selection);
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
    // commit
    nudgeSelection(0, 0);
  }

  // [9] ----------------------------------------------------------------------
  // Suppression, delete button, etc.
  // -------------------------------------------------------------------------

  function addDeleteButton(el) {
    const btn = document.createElement('div'); btn.className = 'pc_delete_btn'; btn.textContent = '×'; btn.title = 'Supprimer';
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
        el.remove(); return;
      }
      api.deleteFurniture(state.active_plan.id, fid).then(() => {
        state.furniture = state.furniture.filter(f => f.id !== fid);
        lsDelColor(state.active_plan.id, fid);
        el.remove();
      }).catch(err => { console.error(err); alert("Suppression impossible (meuble)."); });
    }
  }

  // [10] ---------------------------------------------------------------------
  // Boot / Chargement
  // -------------------------------------------------------------------------

  function fromDBPosition(p) {
    const rot = Number(p.rot || 0);
    return { ...p, x: (+p.x || 0) / PLAN_SUBDIV, y: (+p.y || 0) / PLAN_SUBDIV, rot, rotAbs: rot };
  }

  async function boot() {
    try {
      document.body.classList.add('pc_loading');
      const data = await api.getAll();
      const plans = Array.isArray(data.plans) ? data.plans : [];
      const eleves = Array.isArray(data.eleves) ? data.eleves : [];
      const seats = Array.isArray(data.seats) ? data.seats : [];
      const apiWalls = Array.isArray(data.walls) ? data.walls : []; // si dispo

      const pickActivePlan = (plans, currentActive, apiActive) => {
        if (apiActive) return apiActive;
        if (currentActive) { const keep = plans.find(p => p.id === currentActive.id); if (keep) return keep; }
        return plans[0] || null;
      };
      const active_plan = pickActivePlan(plans, state.active_plan, data.active_plan);

      state.active_plan = active_plan;
      PLAN_SUBDIV = 32; UI_SUBDIV = 32;

      const positions = Array.isArray(data.positions) ? data.positions.map(fromDBPosition) : [];

      // Snapshot tmp -> pour color merge si id change
      const prevTmpByUid = new Map((state.furniture || []).filter(ff => ff && ff.id < 0 && ff.uid).map(ff => [ff.uid, ff]));
      const prevColorById = new Map((state.furniture || []).filter(ff => ff && ff.id > 0).map(ff => [ff.id, ff.color]));

      // mapping meubles serveur => conserver couleur locale si API ne renvoie rien
      const furniture = (Array.isArray(data.furniture) ? data.furniture : []).map(f => {
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
          x: (+f.x || 0) / PLAN_SUBDIV, y: (+f.y || 0) / PLAN_SUBDIV,
          w: (+f.w || 1) / PLAN_SUBDIV, h: (+f.h || 1) / PLAN_SUBDIV,
          rotation: rot, rotAbs: rot, color, radius: !!f.radius
        };
      });

      // murs
      const walls = apiWalls.map(w => {
        const pts = Array.isArray(w.points) ? w.points.map(p => ({ x: (+p.x || 0) / PLAN_SUBDIV, y: (+p.y || 0) / PLAN_SUBDIV })) : [];
        return { id: w.id || genUid(), points: pts };
      });

      state = { ...state, plans, active_plan, eleves, positions, furniture, seats, walls };
      sentNewFurniture.clear();
      render();
    } catch (err) {
      console.error('[boot] fail', err);
      alert("Impossible de charger les plans de classe pour le moment.");
    } finally {
      document.body.classList.remove('pc_loading');
    }
  }

  // [11] ---------------------------------------------------------------------
  // Listeners globaux & Toolbar
  // -------------------------------------------------------------------------

  // Toolbar
  $sel?.addEventListener('change', () => {
    const id = parseInt($sel.value, 10);
    state.active_plan = state.plans.find(p => p.id === id) || state.active_plan;
    PLAN_SUBDIV = 32; UI_SUBDIV = 32; render();
  });
  $new?.addEventListener('click', async () => {
    const name = prompt("Nom du plan :", "Rentrée"); if (!name) return;
    const r = await api.create({ classe_id: classeId, name, width: 30, height: 20, grid_size: unitPx });
    await boot(); if (r.plan_id) { $sel.value = String(r.plan_id); $sel.dispatchEvent(new Event('change')); }
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
  $edit?.addEventListener('click', () => { editMode = !editMode; refreshFurnitureEditability(); });

  // Clavier global : suppression, déplacements, alignements, distributions
  window.addEventListener('keydown', (e) => {
    if (!state.active_plan) return;
    const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key);
    const ctrlAlt = e.ctrlKey && e.altKey;
    if (e.key === 'Delete') { // supprimer sélection
      selection.forEach(n => removeElement(n));
      selection.clear(); refreshSelectionStyling();
      e.preventDefault(); return;
    }
    if (arrow) {
      let stepPx = 1;
      if (e.shiftKey) stepPx = 10;
      if (e.altKey) stepPx = Math.max(1, Math.round(unitPx / UI_SUBDIV)); // 1 tick
      const dx = (e.key === 'ArrowLeft' ? -stepPx : e.key === 'ArrowRight' ? stepPx : 0);
      const dy = (e.key === 'ArrowUp' ? -stepPx : e.key === 'ArrowDown' ? stepPx : 0);
      nudgeSelection(dx, dy);
      e.preventDefault(); return;
    }
    // alignements / répartitions
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

  // ====== MURS : dessin en polyligne sur un calque SVG ======
  (function () {
    const stage = document.getElementById('pc_stage');
    const svg = document.getElementById('pc_svg');
    if (!stage || !svg) return;

    const draw = { mode: null, wall: null, previewEl: null };
    const grid = (window.SEATING_CONF && +window.SEATING_CONF.grid) || +stage.dataset.grid || 32;

    // Helpers
    const NS = 'http://www.w3.org/2000/svg';
    const el = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
    const snap = (v, s) => Math.round(v / s) * s;
    function clientToStage(e) { const r = stage.getBoundingClientRect(); return { x: snap(e.clientX - r.left, grid), y: snap(e.clientY - r.top, grid) }; }
    const ptsAttr = pts => pts.map(p => `${p.x},${p.y}`).join(' ');
    function updPreview(extra) { if (!draw.previewEl || !draw.wall) return; const pts = extra ? [...draw.wall.points, extra] : draw.wall.points; draw.previewEl.setAttribute('points', ptsAttr(pts)); }
    function cleanPreview() { if (draw.previewEl) { draw.previewEl.remove(); draw.previewEl = null; } }
    function setMode(on) { draw.mode = on ? 'wall' : null; if (!on) { draw.wall = null; cleanPreview(); } }

    // Rendu des murs déjà présents (si restaurés ailleurs)
    function renderExistingWalls() {
      const els = (window._SEATING_STATE && window._SEATING_STATE.furniture) || [];
      els.filter(x => x && x.type === 'wall').forEach(w => {
        svg.appendChild(el('polyline', { class: 'wall', 'data-id': w.id, points: ptsAttr(w.points || []) }));
      });
    }
    renderExistingWalls();

    // Events
    stage.addEventListener('click', (e) => {
      if (draw.mode !== 'wall') return;
      const p = clientToStage(e);
      if (!draw.wall) {
        draw.wall = { id: 'wall_' + Math.random().toString(36).slice(2, 9), type: 'wall', points: [p] };
        draw.previewEl = el('polyline', { class: 'wall-preview', points: `${p.x},${p.y}` });
        svg.appendChild(draw.previewEl);
      } else {
        draw.wall.points.push(p);
        updPreview();
      }
    });
    stage.addEventListener('mousemove', (e) => {
      if (draw.mode !== 'wall' || !draw.wall) return;
      updPreview(clientToStage(e));
    });
    stage.addEventListener('dblclick', finalize);
    document.addEventListener('keydown', (e) => {
      if (draw.mode !== 'wall') {
        if (e.shiftKey && (e.key === 'w' || e.key === 'W')) setMode(true);
        return;
      }
      if (e.key === 'Escape') { setMode(false); }
      else if (e.key === 'Enter') { finalize(e); }
      else if (e.key === 'Backspace') { if (draw.wall?.points?.length) { draw.wall.points.pop(); updPreview(); e.preventDefault(); } }
    });

    function finalize() {
      if (draw.mode !== 'wall' || !draw.wall || draw.wall.points.length < 2) { setMode(false); return; }
      svg.appendChild(el('polyline', { class: 'wall', 'data-id': draw.wall.id, points: ptsAttr(draw.wall.points) }));
      // Notifie la persistance (bloc 3.2 ci-dessous)
      if (window.__walls_onAdd) window.__walls_onAdd(draw.wall);
      setMode(false);
    }
  })();
  // ===== MURS — Persistance (localStorage + API) & Reset & Restore =====
  (function () {
    const stage = document.getElementById('pc_stage');
    const svg = document.getElementById('pc_svg');
    const btnReset = document.getElementById('pc_reset_plan');
    if (!stage || !svg) return;

    // --- helpers planId ---
    function getActivePlanId() {
      const sel = document.getElementById('pc_plan_select');
      if (sel && sel.value) return String(sel.value);
      if (window._SEATING_STATE?.active_plan) return String(window._SEATING_STATE.active_plan);
      const cId = (window.SEATING_CONF?.classeId) || stage.dataset.classeId || 'class';
      return `${cId}:default`;
    }

    // --- état mobilier ---
    function furn() { const S = (window._SEATING_STATE = window._SEATING_STATE || {}); if (!Array.isArray(S.furniture)) S.furniture = []; return S.furniture; }

    // --- localStorage ---
    const key = id => `pc_walls_${id}`;
    const loadLocal = id => { try { const r = localStorage.getItem(key(id)); return r ? JSON.parse(r) : []; } catch { return []; } };
    const saveLocal = (id, walls) => { try { localStorage.setItem(key(id), JSON.stringify(walls)); } catch { } };

    // --- API (optionnelle) ---
    async function pushAPI() {
      if (!window.SEATING_URLS || typeof window.SEATING_URLS.upsertFurniture !== 'function') return;
      const planId = getActivePlanId();
      try {
        await fetch(window.SEATING_URLS.upsertFurniture(planId), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(furn())
        });
      } catch (err) { console.warn('upsertFurniture (murs) KO :', err); }
    }

    // --- rendu svg ---
    const NS = 'http://www.w3.org/2000/svg';
    function el(t, a) { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; }
    const ptsAttr = pts => pts.map(p => `${p.x},${p.y}`).join(' ');
    function renderWall(w) { svg.appendChild(el('polyline', { class: 'wall', 'data-id': w.id, points: ptsAttr(w.points || []) })); }
    function clearWalls() { svg.querySelectorAll('.wall, .wall-preview').forEach(n => n.remove()); }

    // --- hooks appelés par le module dessin (3.1) ---
    window.__walls_onAdd = async function (wall) {
      const F = furn(); F.push(wall);
      const planId = getActivePlanId();
      saveLocal(planId, F.filter(x => x?.type === 'wall'));
      await pushAPI();
    };

    window.__walls_onReset = async function () {
      clearWalls();
      const planId = getActivePlanId();
      saveLocal(planId, []);
      const F = furn(); window._SEATING_STATE.furniture = F.filter(x => x?.type !== 'wall');
      await pushAPI();
    };

    // --- restauration au chargement et quand on change de plan ---
    async function restore() {
      const planId = getActivePlanId();
      let F = furn();
      let walls = F.filter(x => x?.type === 'wall');
      if (!walls.length) {
        const loc = loadLocal(planId);
        if (loc.length) { window._SEATING_STATE.furniture = F = [...F, ...loc]; walls = loc; }
      }
      clearWalls();
      walls.forEach(renderWall);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restore); else restore();

    const sel = document.getElementById('pc_plan_select');
    if (sel && !sel.dataset.wallsBound) { sel.addEventListener('change', restore); sel.dataset.wallsBound = '1'; }

    // --- bouton Réinitialiser ---
    if (btnReset && !btnReset.dataset.wallResetBound) {
      btnReset.addEventListener('click', async () => { if (window.__walls_onReset) await window.__walls_onReset(); });
      btnReset.dataset.wallResetBound = '1';
    }
  })();
  // ===== MURS — Persist, Restore & Auto-repaint même après hydratation du plan =====
  (function () {
    const stage = document.getElementById('pc_stage');
    const svg = document.getElementById('pc_svg');
    if (!stage || !svg) return;

    // ------------ helpers identifiant de plan
    function getActivePlanId() {
      const sel = document.getElementById('pc_plan_select');
      if (sel && sel.value) return String(sel.value);
      if (window._SEATING_STATE?.active_plan) return String(window._SEATING_STATE.active_plan);
      const cId = (window.SEATING_CONF?.classeId) || stage.dataset.classeId || 'class';
      return `${cId}:default`;
    }

    // ------------ état / storage / api
    function furn() {
      const S = (window._SEATING_STATE = window._SEATING_STATE || {});
      if (!Array.isArray(S.furniture)) S.furniture = [];
      return S.furniture;
    }
    const k = id => `pc_walls_${id}`;
    const loadLocal = id => { try { const r = localStorage.getItem(k(id)); return r ? JSON.parse(r) : []; } catch { return []; } };
    const saveLocal = (id, walls) => { try { localStorage.setItem(k(id), JSON.stringify(walls)); } catch { } };

    async function pushAPI() {
      if (!window.SEATING_URLS || typeof window.SEATING_URLS.upsertFurniture !== 'function') return;
      const planId = getActivePlanId();
      try {
        await fetch(window.SEATING_URLS.upsertFurniture(planId), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(furn())
        });
      } catch (e) { console.warn('upsertFurniture(walls) KO', e); }
    }

    // ------------ rendu svg
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
    const ptsAttr = pts => (pts || []).map(p => `${p.x},${p.y}`).join(' ');
    function clearRender() { svg.querySelectorAll('.wall, .wall-preview').forEach(n => n.remove()); }
    function renderWalls(walls) { walls.forEach(w => svg.appendChild(mk('polyline', { class: 'wall', 'data-id': w.id, points: ptsAttr(w.points) }))); }

    // ------------ fonctions globales (appelées par le module dessin et le reset)
    window.__walls_onAdd = async function (wall) {
      const F = furn(); F.push(wall);
      const id = getActivePlanId();
      saveLocal(id, F.filter(x => x?.type === 'wall'));
      renderWalls([wall]); // instantané même si pas d’API
      await pushAPI();
    };
    window.__walls_onReset = async function () {
      clearRender();
      const id = getActivePlanId();
      saveLocal(id, []);
      const F = furn(); window._SEATING_STATE.furniture = F.filter(x => x?.type !== 'wall');
      await pushAPI();
    };

    // ------------ routine de restauration robuste
    function restoreNow() {
      const id = getActivePlanId();
      let F = furn();
      let walls = F.filter(x => x?.type === 'wall');
      if (!walls.length) {
        const loc = loadLocal(id);
        if (loc.length) {
          window._SEATING_STATE.furniture = F = [...F, ...loc];
          walls = loc;
        }
      }
      clearRender();
      if (walls.length) renderWalls(walls);
    }

    // (A) au chargement
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', restoreNow);
    } else {
      restoreNow();
    }

    // (B) quand on change de plan avec le select
    const sel = document.getElementById('pc_plan_select');
    if (sel && !sel.dataset.wallsBound) {
      sel.addEventListener('change', restoreNow);
      sel.dataset.wallsBound = '1';
    }

    // (C) si ton JS émet des événements custom après hydratation/rendu, on s’y branche.
    // Tu peux déclencher window.dispatchEvent(new Event('seating:plan:rendered')) dans ton code quand le plan est prêt.
    window.addEventListener('seating:plan:rendered', restoreNow);
    window.addEventListener('seating:furniture:loaded', restoreNow);

    // (D) filet de sécurité : si après X ms le SVG a été vidé/rerendu → on re-peint.
    let tries = 0;
    const watchdog = setInterval(() => {
      tries++;
      // si pas de mur dans le DOM alors qu’on en a en state/local → re-render
      const hasDomWalls = !!svg.querySelector('.wall');
      const id = getActivePlanId();
      const F = furn();
      const hasWallsSomewhere = F.some(x => x?.type === 'wall') || loadLocal(id).length > 0;
      if (!hasDomWalls && hasWallsSomewhere) restoreNow();
      if (tries > 25) clearInterval(watchdog); // ~2.5s si 100ms
    }, 100);
  })();

  // ===== Supprimer un plan =====
  // ===== Supprimer un plan (utilise SEATING_URLS.deletePlan) =====
  (function () {
    const sel = document.getElementById('pc_plan_select');
    const btn = document.getElementById('pc_delete_plan');
    const svg = document.getElementById('pc_svg');

    if (!btn || !sel) return;

    const furn = () => {
      const S = (window._SEATING_STATE = window._SEATING_STATE || {});
      if (!Array.isArray(S.furniture)) S.furniture = [];
      return S.furniture;
    };
    const getPlanId = () => (sel.value ? String(sel.value).trim() : (window._SEATING_STATE?.active_plan ? String(window._SEATING_STATE.active_plan).trim() : null));
    const clearWallsDOM = () => { if (svg) svg.querySelectorAll('.wall, .wall-preview').forEach(n => n.remove()); };
    const clearWallsState = (pid) => {
      const F = furn();
      window._SEATING_STATE.furniture = F.filter(x => x?.type !== 'wall');
      try { localStorage.removeItem(`pc_walls_${pid}`); } catch { }
    };
    const clearStageDOM = () => {
      const canvas = document.getElementById('pc_canvas');
      if (canvas) canvas.replaceChildren();
    };

    async function callDeleteAPI(planId) {
      if (!window.SEATING_URLS?.deletePlan) return false;
      const url = window.SEATING_URLS.deletePlan(planId);
      try {
        // On envoie un POST (conforme à la route ajoutée)
        const res = await fetch(url, { method: 'POST', headers: { 'Accept': 'application/json' } });
        if (res.ok) return true;
        // Fallback DELETE si tu préfères supprimer via DELETE aussi
        if (res.status === 405) {
          const res2 = await fetch(url, { method: 'DELETE', headers: { 'Accept': 'application/json' } });
          return res2.ok;
        }
        return false;
      } catch (e) {
        console.warn('Erreur suppression côté API :', e);
        return false;
      }
    }

    function removeSelectedOption() {
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      if (opt) opt.remove();
      if (!sel.options.length) {
        window._SEATING_STATE.active_plan = null;
        return;
      }
      sel.selectedIndex = 0;
      window._SEATING_STATE.active_plan = sel.value || null;
      sel.dispatchEvent(new Event('change'));
    }

    btn.addEventListener('click', async () => {
      const planId = getPlanId();
      if (!planId) { alert("Aucun plan sélectionné."); return; }

      const name = sel.selectedOptions[0]?.text || `Plan ${planId}`;
      const isActive = String(window._SEATING_STATE?.active_plan || '') === String(planId);
      if (!confirm(`Supprimer le plan « ${name} »${isActive ? " (actif)" : ""} ?\nCette action est irréversible.`)) return;

      const serverOK = await callDeleteAPI(planId);

      // Nettoyage local garanti (UX d'abord)
      clearWallsDOM();
      clearWallsState(planId);
      clearStageDOM();
      removeSelectedOption();

      window.dispatchEvent(new CustomEvent('seating:plan:deleted', { detail: { planId, serverOK } }));
      if (!serverOK) console.warn('[Plan] Suppression : serveur non confirmé — nettoyage local appliqué.');
    });
  })();


  // À lancer au chargement et sur change du select :
  (function () {
    const sel = document.getElementById('pc_plan_select');
    const ids = ['pc_activate', 'pc_duplicate', 'pc_delete_plan', 'pc_export_pdf', 'pc_reset_plan'];
    function refreshActionsState() {
      const has = !!(sel && sel.value);
      ids.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !has; });
    }
    if (sel) {
      refreshActionsState();
      sel.addEventListener('change', refreshActionsState);
    }
  })();




  // INIT
  boot().catch(console.error);

})();
