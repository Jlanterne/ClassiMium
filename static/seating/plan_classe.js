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
  // ---- Échelle réelle pour les élèves (1 unité = 10 cm par défaut)
  const CM_PER_UNIT = 25;                 // adapte si chez toi 1 unité ≠ 10 cm
  const STUDENT_W_CM = 70;                // largeur réelle
  const STUDENT_H_CM = 50;                // hauteur réelle
  const cmToUnits = (cm) => cm / CM_PER_UNIT;

  const CARD_ROT_STATES = [0, 90, 270]; // 270 = -90
  function normCardRotToIdx(deg) {
    // mappe n'importe quel angle vers {0,90,270} — 180 devient 270
    let d = ((deg % 360) + 360) % 360;
    if (d >= 315 || d < 45) return 0;      // ~0
    if (d >= 45 && d < 135) return 1;      // ~90
    // 135–225 (≈180) et 225–315 (≈270) => 270
    return 2;
  }






  // Taille élève en unités (arrondie au “tick” UI pour coller à l’aimantation)
  function studentFootprintUnits() {
    const w = Math.max(TICK, Math.round(cmToUnits(STUDENT_W_CM) * UI_SUBDIV) / UI_SUBDIV);
    const h = Math.max(TICK, Math.round(cmToUnits(STUDENT_H_CM) * UI_SUBDIV) / UI_SUBDIV);
    return { w, h };
  }

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
  let $svg = document.getElementById('pc_svg') || null;


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
  // helpers LS (mets-les avec tes autres helpers LS)
  const posRotKey = pid => `pc_posrot_${pid}`;
  function lsGetPosRots(pid) { try { return JSON.parse(localStorage.getItem(posRotKey(pid)) || '{}'); } catch { return {}; } }
  function lsSetPosRot(pid, eleveId, rot) {
    try { const m = lsGetPosRots(pid); m[eleveId] = rot; localStorage.setItem(posRotKey(pid), JSON.stringify(m)); } catch { }
  }

  // --- Helpers murs: encode (→ stockage) / decode (← lecture) en base PLAN_SUBDIV ---
  function encodeWallsForStorage(walls) {
    // walls: [{id, points:[{x,y}]}] en UNITÉS DE PLAN
    // -> [{id, points:[{x,y}]}] x,y entiers en sous-unités (× PLAN_SUBDIV)
    return (walls || []).map(w => ({
      id: w.id || genUid(),
      points: (w.points || []).map(p => ({
        x: Math.round((+p.x || 0) * PLAN_SUBDIV),
        y: Math.round((+p.y || 0) * PLAN_SUBDIV),
      }))
    }));
  }

  function decodeWallsFromStorage(stored) {
    // stored: [{id, points:[{x,y}]}] x,y entiers en sous-unités
    // -> [{id, points:[{x,y}]}] x,y en UNITÉS DE PLAN
    return (stored || []).map(w => ({
      id: w.id || genUid(),
      points: (w.points || []).map(p => ({
        x: (+p.x || 0) / PLAN_SUBDIV,
        y: (+p.y || 0) / PLAN_SUBDIV,
      }))
    }));
  }

  // place ça avant l'INIT (avant boot().catch(...))
  function setupFullscreenExact($wrap, onFit, onRender) {
    const btn = document.getElementById('pc_fullscreen');
    if (!$wrap || !btn) return;

    function enter() { if ($wrap.requestFullscreen) $wrap.requestFullscreen(); }
    function exit() { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); }

    btn.addEventListener('click', () => {
      if (document.fullscreenElement) exit(); else enter();
    });

    // quand on entre/sort du plein écran -> recalcul (fit + render)
    document.addEventListener('fullscreenchange', () => {
      try { onFit && onFit(); } catch { }
      try { onRender && onRender(); } catch { }
    });
  }

  const rotLockKey = (pid, eleveId) => `pc_rotlock_${pid}_${eleveId}`;
  const lsGetRotLock = (pid, eid) => { try { return localStorage.getItem(rotLockKey(pid, eid)) === '1'; } catch { return false; } };
  const lsSetRotLock = (pid, eid) => { try { localStorage.setItem(rotLockKey(pid, eid), '1'); } catch { } };

  function maybeLockRotation(card, eleveId) {
    if (!state.active_plan) return;
    const pid = state.active_plan.id;
    if (lsGetRotLock(pid, eleveId)) return;        // déjà locké

    // → première rotation qu’on constate : on verrouille
    lsSetRotLock(pid, eleveId);

    // retirer/masquer les boutons et désactiver la molette Alt
    card.querySelectorAll('.pc_rot_btn').forEach(b => b.remove());
    card.removeEventListener('wheel', onCardAltWheel, { passive: false }); // cf. handler ci-dessous
  }

  // --- Snap élèves: 0 / 90 / 270 (on évite 180 pour garder le nom lisible)
  // --- Snap élèves: 0 / 90 / 270 (on évite 180 pour garder le nom lisible)
  function snapRotStudent(deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d < 45 || d >= 315) return 0;   // proche de 0
    if (d < 135) return 90;             // proche de 90
    return 270;                         // 135–315 => 270
  }

  // Récupère l’angle visuel (libre) et l’angle snap (modèle)
  function getCardAngles(card) {
    const visu = parseFloat(card.dataset.rotVisuAbs || card.dataset.rotAbs || card.dataset.rot || '0') || 0;
    const snap = snapRotStudent(visu);
    return { visu, snap };
  }

  function onCardAltWheel(e) {
    if (!e.altKey) return;
    e.preventDefault();
    const card = e.currentTarget;
    setCardRotation(card, (e.deltaY > 0 ? -1 : 1), { snap: false });
  }

  // remplace le snap neutre par un snap directionnel selon le signe du décalage
  function snapUnitsDir(v, dir /* dx ou dy */) {
    const s = v * UI_SUBDIV;
    if (dir > 0) return Math.ceil(s) / UI_SUBDIV;   // on pousse vers + (droite/haut)
    if (dir < 0) return Math.floor(s) / UI_SUBDIV;   // on pousse vers - (gauche/bas)
    return Math.round(s) / UI_SUBDIV;                 // cas neutre
  }





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
    // désormais basé sur 70x50 cm, pas sur 96 px
    return studentFootprintUnits();
  }

  function buildRotateControls(card) {
    const nameEl = card.querySelector('.pc_name_in');
    if (!nameEl) return;
    if (nameEl.querySelector('.pc_rot_btn')) return; // évite les doublons

    const mk = (cls, title, delta) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `pc_rot_btn ${cls}`;
      b.textContent = (delta < 0 ? '↺' : '↻');
      b.title = title;
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.addEventListener('mousedown', e => e.stopPropagation());
      b.addEventListener('click', e => e.stopPropagation());
      // passive: true pour touchstart (pas de preventDefault)
      b.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
      b.addEventListener('click', () => setCardRotation(card, delta, { snap: true }));
      return b;
    };

    nameEl.prepend(mk('rot-left', 'Pivoter -90°', -90));
    nameEl.append(mk('rot-right', 'Pivoter +90°', +90));

    // Alt + molette = rotation fine
    if (!card._wheelBound) {
      card.addEventListener('wheel', (e) => {
        if (!e.altKey) return;
        e.preventDefault();
        setCardRotation(card, (e.deltaY > 0 ? -1 : 1), { snap: false });
      }, { passive: false });
      card._wheelBound = true;
    }
  }



  // Optionnel : garde l’API existante, mais ne supprime plus les boutons
  function refreshCardRotationUI(card /*, nameEl */) {
    // On ne masque plus/retire rien : les deux flèches restent toujours accessibles
    // Laisse la molette Alt active (liée dans buildRotateControls)
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
    getAll: (planId) => {
      const q = planId ? `?plan_id=${encodeURIComponent(planId)}` : '';
      return fetch(`${API_BASE}/plans/${classeId}${q}`, { credentials: 'same-origin', cache: 'no-store' })
        .then(r => r.json());
    },
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
    const payload = state.positions.map(p => {
      const r = Math.round((p.rotAbs ?? p.rot ?? 0) % 360);
      return {
        eleve_id: p.eleve_id,
        x: Math.round(p.x * PLAN_SUBDIV),
        y: Math.round(p.y * PLAN_SUBDIV),
        seat_id: p.seat_id ?? null,
        rotation: r,   // ← clé "rotation" alignée sur les meubles / backend
        rot: r         // ← optionnel, pour compat si l’API accepte encore "rot"
      };
    });
    api.savePositions(state.active_plan.id, payload).catch(console.error);
  }, 500);


  // ---- AUTOSAVE meubles avec resync APRES succès API ----
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
              rotation: Math.round((f.rotAbs ?? f.rotation ?? 0) % 360),
              z: f.z || 0,
              radius: !!f.radius
            }));

          if (!payload.length) return;

          const justSentUids = new Set(
            payload.filter(p => !p.id && p.client_uid).map(p => p.client_uid)
          );
          justSentUids.forEach(uid => sentNewFurniture.add(uid));

          // ⬇️ on ATTEND le retour serveur
          await api.saveFurniture(state.active_plan.id, payload);

          // ✅ et seulement maintenant on resynchronise (immédiatement)
          resyncSoon(0);
        } catch (err) {
          console.error('[autosaveFurniture] PUT failed', err);
          // on réautorise un renvoi pour les nouveaux qui ont échoué
          sentNewFurniture.forEach(uid => {
            // si ce uid était dans le lot échoué, on le retire
            // (simple : on reset tout le set)
          });
          sentNewFurniture.clear();
        }
      }, 500); // même debounce que chez toi
    };
  })();

  // ---- AUTOSAVE murs (déplacés au clavier) ----
  const autosaveWalls = debounce(async () => {
    if (!state.active_plan) return;
    const planId = state.active_plan.id;
    const payloadWalls = encodeWallsForStorage(state.walls);
    try { await api.saveWalls?.(planId, payloadWalls); } catch (e) { console.warn('saveWalls API KO', e); }
    try { localStorage.setItem(`pc_walls_${planId}`, JSON.stringify(payloadWalls)); } catch { }
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
    // SVG overlay (murs)
    if (!$svg) {
      $svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      $svg.setAttribute('id', 'pc_svg');
      $svg.classList.add('pc_svg');
      $stage.appendChild($svg);
    }
    // s'assure de sa position/tailles
    $svg.style.position = 'absolute';
    $svg.style.left = '0';
    $svg.style.top = '0';
    $svg.style.width = '100%';
    $svg.style.height = '100%';
    $svg.style.pointerEvents = 'none';

    ensureHatchPattern();

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

    // élèves
    for (const p of state.positions) {
      if (exclude.eleveId && p.eleve_id === exclude.eleveId) continue;
      const rot = (p.rotAbs ?? p.rot ?? 0);
      const r = rectFromTopLeftWithRotation(p.x, p.y, fp.w, fp.h, rot);
      rects.push({ ...r, kind: 'eleve', id: p.eleve_id });
    }

    // meubles
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
    const tol = TICK * 0.5; // tolérance d'overlap orthogonal
    const onTick = v => Math.round(v * UI_SUBDIV) / UI_SUBDIV; // arrondi neutre (ne dépasse pas si v est déjà sur la grille)
    const overlap1D = (a0, a1, b0, b1) => !(a1 <= b0 + tol || b1 <= a0 + tol);

    let best = null; // {x,y,d}
    const consider = (nx, ny) => {
      // positions cibles calculées par ARÊTE (déjà sur la grille)
      const cand = { x: onTick(nx), y: onTick(ny), w: r.w, h: r.h };
      // restreint au plan
      const c = clampToStage(cand.x, cand.y, r.w, r.h);
      const snapped = { x: c.gx, y: c.gy, w: r.w, h: r.h };
      if (collides(snapped, others)) return;
      const d = Math.abs(snapped.x - r.x) + Math.abs(snapped.y - r.y);
      if (!best || d < best.d) best = { ...snapped, d };
    };

    for (const o of others) {
      // alignement horizontal (arêtes verticales) si recouvrement Y
      if (overlap1D(r.y, r.y + r.h, o.y, o.y + o.h)) {
        const gapRight = o.x - (r.x + r.w);          // r à gauche de o
        const gapLeft = (o.x + o.w) - r.x;          // r à droite de o
        if (Math.abs(gapRight) <= margin) consider(o.x - r.w, r.y);     // colle r.x + r.w = o.x
        if (Math.abs(gapLeft) <= margin) consider(o.x + o.w, r.y);     // colle r.x = o.x + o.w
      }
      // alignement vertical (arêtes horizontales) si recouvrement X
      if (overlap1D(r.x, r.x + r.w, o.x, o.x + o.w)) {
        const gapBottom = o.y - (r.y + r.h);         // r au-dessus de o
        const gapTop = (o.y + o.h) - r.y;         // r en dessous de o
        if (Math.abs(gapBottom) <= margin) consider(r.x, o.y - r.h);    // colle r.y + r.h = o.y
        if (Math.abs(gapTop) <= margin) consider(r.x, o.y + o.h);    // colle r.y = o.y + o.h
      }
    }

    // aimantation aux bords du plan
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
    if ($svg) $svg.innerHTML = '<defs></defs>'; ensureHatchPattern();
  }

  function moyClass(m20) { if (m20 == null) return ''; if (m20 >= 16) return 'mAp'; if (m20 >= 13) return 'mA'; if (m20 >= 8) return 'mPA'; return 'mNA'; }

  // -- élèves
  // -- élèves
  function setCardRotation(card, delta, { snap = false } = {}) {
    // angle visuel courant (pour l'affichage)
    let visu = parseFloat(card.dataset.rotVisuAbs || card.dataset.rotAbs || card.dataset.rot || '0') || 0;

    // applique l'incrément
    visu += delta;

    // si clic boutons: on borne à [-90, 90] pour éviter 180 (lisibilité du nom)
    if (snap) {
      if (visu > 90) visu = 90;
      if (visu < -90) visu = -90;
    }

    // angle snap (modèle) = 0 / 90 / 270
    const snapAbs = snapRotStudent(visu);

    // maj datasets + rendu
    card.dataset.rotVisuAbs = String(visu);
    card.dataset.rotAbs = String(snapAbs);
    card.dataset.rot = String(snapAbs);           // pour compat avec anciens usages
    card.style.transformOrigin = 'center center';
    card.style.transform = `rotate(${visu}deg)`;  // on affiche l'angle fin

    // pousse dans le state + autosave
    const eleveId = parseInt(card.dataset.eleveId, 10);
    const p = state.positions.find(x => x.eleve_id === eleveId);
    if (p) {
      p.rotAbs = snapAbs;
      p.rot = snapAbs;
      if (state.active_plan) lsSetPosRot(state.active_plan.id, eleveId, snapAbs); // NEW
      autosavePositions();
    }


    // gestion visibilité boutons (comme chez toi)
    const leftBtn = card.querySelector('.pc_rot_btn.rot-left');
    const rightBtn = card.querySelector('.pc_rot_btn.rot-right');
    if (leftBtn && rightBtn && snap) {
      if (visu === 0) {
        leftBtn.style.display = "inline-block";
        rightBtn.style.display = "inline-block";
      } else if (visu === -90) {
        leftBtn.style.display = "none";
        rightBtn.style.display = "inline-block";
      } else if (visu === 90) {
        rightBtn.style.display = "none";
        leftBtn.style.display = "inline-block";
      }
    }
  }








  function addRotateButton(card) {
    // ↺ bouton
    const btnL = document.createElement('div');
    btnL.className = 'pc_delete_btn';
    btnL.style.right = '46px';
    btnL.title = 'Pivoter -90°';
    btnL.textContent = '↺';
    btnL.addEventListener('click', (e) => { e.stopPropagation(); setCardRotation(card, -90, { snap: true }); });

    // ↻ bouton
    const btnR = document.createElement('div');
    btnR.className = 'pc_delete_btn';
    btnR.style.right = '26px';
    btnR.title = 'Pivoter +90°';
    btnR.textContent = '↻';
    btnR.addEventListener('click', (e) => { e.stopPropagation(); setCardRotation(card, +90, { snap: true }); });

    // Alt+molette = rotation fine ±1°
    card.addEventListener('wheel', (e) => {
      if (!e.altKey) return;
      e.preventDefault();
      setCardRotation(card, (e.deltaY > 0 ? -1 : 1), { snap: false }); // visuel libre, modèle = snap
    }, { passive: false });


    card.append(btnL, btnR);
  }


  function addCard(eleve, pos) {
    // === conteneur carte
    const card = document.createElement('div');
    card.className = 'pc_card';
    card.dataset.type = 'eleve';
    card.dataset.id = eleve.id;
    card.dataset.eleveId = eleve.id;

    if (eleve.sexe) card.dataset.sexe = eleve.sexe;
    if (eleve.niveau) card.dataset.niveau = eleve.niveau;
    card.dataset.prenom = eleve.prenom || '';

    // position (en px) depuis les unités
    card.style.left = `${toPx(pos.x)}px`;
    card.style.top = `${toPx(pos.y)}px`;
    card.title = `${eleve.prenom || ''} ${eleve.nom || ''}`.trim();

    // dimension élève en unités (footprint réel 70x50 cm), converti en px
    const fp = studentFootprintUnits();
    card.style.width = `${toPx(fp.w)}px`;
    card.style.height = `${toPx(fp.h)}px`;

    // === contenu interne (photo + ruban prénom)
    const inner = document.createElement('div');
    inner.className = 'pc_card_in';

    // rotation initiale (visuelle & snap)
    const initRot = Number.isFinite(pos.rotAbs ?? pos.rot)
      ? (pos.rotAbs ?? pos.rot)
      : 0;
    card.dataset.rotAbs = String(initRot);
    card.dataset.rotVisuAbs = String(initRot);
    card.dataset.rot = String(initRot);
    card.style.transformOrigin = 'center center';
    card.style.transform = `rotate(${initRot}deg)`;

    // photo
    const img = document.createElement('img');
    img.src = PHOTOS_BASE + (eleve.photo_filename || 'default.jpg');
    img.draggable = card.draggable = false;
    img.addEventListener('dragstart', ev => ev.preventDefault());
    card.addEventListener('dragstart', ev => ev.preventDefault());

    // ruban prénom (reste sous les boutons)
    const name = document.createElement('div');
    name.className = 'pc_name_in';
    name.textContent = eleve.prenom || '';
    const sexCls = (eleve.sexe === 'FEMININ' || eleve.sexe === 'F')
      ? 'sex-fille'
      : (eleve.sexe === 'MASCULIN' || eleve.sexe === 'M')
        ? 'sex-garcon'
        : '';
    if (sexCls) name.classList.add(sexCls);

    // badge moyenne (gauche)
    const bM = document.createElement('div');
    bM.className = `badge moy ${moyClass(eleve.moyenne_20)}`;
    bM.textContent = (eleve.moyenne_20 != null)
      ? Math.round(eleve.moyenne_20)
      : '—';

    // assemble
    inner.append(img, name);
    card.append(bM, inner);

    // === boutons de rotation (au niveau .pc_card, au-dessus du ruban)
    // -> NE PAS les mettre dans name; on veut qu’ils dépassent et restent au-dessus
    buildRotateControls(card);

    // === autres contrôles / interactions
    addDeleteButton(card);                    // croix de suppression (z-index déjà haut)
    card.addEventListener('pointerdown', startDragCard);
    card.addEventListener('click', handleSelectableClick);

    // Alt+molette pour rotation fine est branché dans buildRotateControls
    // On ne masque plus les boutons selon l’angle, donc pas d’appel à refreshCardRotationUI

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

    // garde les couleurs fille/garçon aussi dans le fantôme (optionnel)
    const sexCls = (eleve.sexe === 'FEMININ' || eleve.sexe === 'F')
      ? 'sex-fille'
      : (eleve.sexe === 'MASCULIN' || eleve.sexe === 'M')
        ? 'sex-garcon'
        : '';
    if (sexCls) name.classList.add(sexCls);

    inner.append(img, name);
    ghost.append(inner);
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
    // palette absente → rien à faire
    if (!$palette) return;

    // Empêche la duplication des items et des listeners
    if ($palette.dataset.built === '1') return;

    // helpers DOM simples (JS pur, pas de TS)
    function el(tag, className, attrs) {
      const n = document.createElement(tag);
      if (className) n.className = className;
      if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    }

    // Nettoie et reconstruit
    $palette.innerHTML = '';

    // ---------- Item spécial : Mur (tracer)
    (function buildWallTool() {
      const item = el('div', 'pc_furn_tpl wall_tool');
      // Thumb visuelle “mur”
      const thumb = el('div', 'thumb');
      thumb.style.height = '12px';
      thumb.style.borderRadius = '6px';
      thumb.style.background = '#111827';
      const info = el('div', 'info');
      const name = el('div', 'name'); name.textContent = 'Mur (tracer)';
      const dims = el('div', 'dims'); dims.textContent = 'clics successifs – Entrée pour finir';
      info.append(name, dims);
      // pas de color picker pour un mur
      item.append(thumb, info);

      // Important : on veut un CLIC simple qui démarre l’outil.
      // On ne met PAS de cursor: grab ici pour éviter les confusions avec le drag de meuble.
      item.style.cursor = 'pointer';

      // On évite que des handlers globaux de drag prennent la main
      const start = (ev) => {
        ev.preventDefault();         // empêche un “drag” natif
        ev.stopPropagation();
        startWallTool(ev);           // ta fonction de tracé
      };
      item.addEventListener('click', start);
      // Double sécurité : si l’utilisateur maintient et relâche (pointer), on démarre pareil
      item.addEventListener('pointerdown', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
      item.addEventListener('pointerup', start);

      $palette.appendChild(item);
    })();

    // ---------- Items "meubles" depuis FURN_DEFS
    FURN_DEFS.forEach((def) => {
      const item = el('div', 'pc_furn_tpl');
      item.style.cursor = 'grab';

      // Couleur courante pour ce type (fallback sur défauts)
      const baseColor = (FURN_COLORS[def.type] || FURN_DEF_COLORS[def.type] || '#ffffff');

      // Thumb
      const thumb = el('div', 'thumb' + (def.type === 'table_round' ? ' round' : ''));
      thumb.style.background = baseColor;
      thumb.style.borderColor = baseColor;

      // Info
      const info = el('div', 'info');
      const name = el('div', 'name'); name.textContent = def.label || def.type;
      const dims = el('div', 'dims'); dims.textContent = `${def.w}×${def.h}`;
      info.append(name, dims);

      // Color picker (met à jour la couleur par défaut du TYPE)
      const cp = el('input', '');
      cp.type = 'color';
      cp.value = baseColor;
      cp.title = `Couleur ${def.label || def.type}`;
      // Important : un color picker ne doit jamais déclencher le drag
      ['pointerdown', 'mousedown', 'click'].forEach(evt =>
        cp.addEventListener(evt, (e) => { e.stopPropagation(); })
      );
      cp.addEventListener('input', () => {
        FURN_COLORS[def.type] = cp.value;
        thumb.style.background = cp.value;
        thumb.style.borderColor = cp.value;
      });

      // Drag pour créer un meuble
      const onPointerDown = (ev) => {
        // Si on a cliqué le color picker, on ne drag pas
        if (ev.target === cp) return;
        startCreateFurnitureDrag(ev, def);
      };
      item.addEventListener('pointerdown', onPointerDown);

      item.append(thumb, info, cp);
      $palette.appendChild(item);
    });

    // Marqueur de construction (évite de rebinder en double)
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
    const rot = parseFloat(card.dataset.rotAbs || card.dataset.rot || '0') || 0;

    // correction px si carte tournée (90/270) + dims effectives en unités
    const box = stageInnerBox();
    const pxAdj = adjustClientPxForSwap(box.left + lx, box.top + ly, fp.w, fp.h, rot);

    // clamp/snap dans le stage avec les dimensions effectives
    const gxgy = clientToUnitsClamped(pxAdj.leftPx, pxAdj.topPx, pxAdj.wEff, pxAdj.hEff);

    // cherche le spot libre
    let spot = findNearestFreeSpot(gxgy.x, gxgy.y, pxAdj.wEff, pxAdj.hEff, { eleveId: dragData.eleveId });
    if (spot) {
      spot = snapCollapse(spot, rectsInPlan({ eleveId: dragData.eleveId }));
      const p = state.positions.find(p => p.eleve_id === dragData.eleveId);
      if (p) {
        // reconversion vers le coin haut-gauche stocké (non tourné)
        p.x = snapUnits(spot.x - pxAdj.dx);
        p.y = snapUnits(spot.y - pxAdj.dy);
      } else {
        state.positions.push({
          eleve_id: dragData.eleveId,
          x: snapUnits(spot.x - pxAdj.dx),
          y: snapUnits(spot.y - pxAdj.dy),
          seat_id: null,
          rot: 0, rotAbs: 0
        });
      }
      autosavePositions();
    } else {
      shake(card);
    }

    dragData = null;
    render();
  }


  // Projette (x,y) sur le segment de mur le plus proche si assez proche.
  // Retourne {x,y} en UNITÉS, ou null si trop loin.
  function snapToNearestWall(x, y, maxDist = 0.6) {
    if (!Array.isArray(state.walls) || !state.walls.length) return null;

    let best = null;
    const pt = { x, y };

    function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
    function clamp01(t) { return Math.max(0, Math.min(1, t)); }

    for (const w of state.walls) {
      const pts = (w.points || []);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const vx = b.x - a.x, vy = b.y - a.y;
        const len2 = vx * vx + vy * vy || 1e-9;
        // projection scalaire t dans [0,1]
        const t = clamp01(((pt.x - a.x) * vx + (pt.y - a.y) * vy) / len2);
        const proj = { x: a.x + t * vx, y: a.y + t * vy };
        const d2 = dist2(pt, proj);
        if (!best || d2 < best.d2) best = { d2, p: proj };
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
      const box = stageInnerBox();
      const pxAdj = adjustClientPxForSwap(box.left + L, box.top + T, gw, gh, rotNow);

      let { x: gx, y: gy } = clientToUnitsClamped(pxAdj.leftPx, pxAdj.topPx, pxAdj.wEff, pxAdj.hEff);
      let spot = findNearestFreeSpot(gx, gy, pxAdj.wEff, pxAdj.hEff, {
        furnitureId: node.dataset.id ? parseInt(node.dataset.id, 10) : -1
      });
      if (!spot) { shake(node); return; }
      spot = snapCollapse(spot, rectsInPlan({ furnitureId: node.dataset.id ? parseInt(node.dataset.id, 10) : -1 }));

      const id = node.dataset.id ? parseInt(node.dataset.id, 10) : null;
      const fRef = (id != null) ? state.furniture.find(x => x.id === id) : null;
      if (fRef) {
        fRef.w = gw; fRef.h = gh;
        fRef.x = snapUnits(spot.x - pxAdj.dx);
        fRef.y = snapUnits(spot.y - pxAdj.dy);
      }
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


  // Rend tous les murs présents dans state.walls
  function renderWalls() {
    if (!$svg) return;
    ensureHatchPattern(); // garde <defs>#hatch

    // on nettoie seulement les murs finalisés (pas la preview de l'outil)
    $svg.querySelectorAll('.wall').forEach(n => n.remove());

    for (const w of (state.walls || [])) {
      if (!w.points || w.points.length < 2) continue;

      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      poly.classList.add('wall');
      poly.dataset.wallId = String(w.id);
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', 'url(#hatch)');
      poly.setAttribute('stroke-width', Math.max(3, unitPx * 0.12));
      poly.style.pointerEvents = 'stroke';           // ← cliquable uniquement sur le trait
      poly.addEventListener('click', handleSelectableClick);

      const pts = w.points.map(p => `${toPx(p.x)},${toPx(p.y)}`).join(' ');
      poly.setAttribute('points', pts);
      $svg.appendChild(poly);
    }
  }




  // Démarre l’outil de tracé avec prévisualisation live + persistance
  function startWallTool(ev) {
    ev?.preventDefault?.();
    if (!$svg || !$stage || !state.active_plan) return;

    const planId = state.active_plan.id;
    let currentWall = { id: genUid(), points: [] };

    // 1) Segments confirmés
    const progress = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    progress.classList.add('wall');
    progress.setAttribute('fill', 'none');
    progress.setAttribute('stroke', 'url(#hatch)');
    progress.setAttribute('stroke-width', Math.max(3, unitPx * 0.12));
    $svg.appendChild(progress);

    // 2) Jambe dynamique
    const preview = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    preview.classList.add('wall-preview');
    preview.setAttribute('fill', 'none');
    preview.setAttribute('stroke', '#60a5fa');
    preview.setAttribute('stroke-width', Math.max(2, unitPx * 0.10));
    preview.setAttribute('stroke-dasharray', '6 4');
    $svg.appendChild(preview);

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
      currentWall.points.push(ptToUnits(e.clientX, e.clientY)); // ← UNITÉS DE PLAN
      updateProgress();
      updatePreview(e.clientX, e.clientY);
    };

    async function persistWalls() {
      // ENCODE pour persister (x,y entiers en sous-unités)
      const payloadWalls = encodeWallsForStorage(state.walls);

      // 1) Serveur (si endpoint dispo)
      try { await api.saveWalls?.(planId, payloadWalls); } catch (e) { console.warn('saveWalls API KO', e); }

      // 2) LocalStorage (même format encodé)
      try { localStorage.setItem(`pc_walls_${planId}`, JSON.stringify(payloadWalls)); } catch { }
    }

    const finish = async () => {
      teardown();
      if (currentWall.points.length >= 2) {
        state.walls.push(currentWall);  // ← on garde en UNITÉS dans le state
        renderWalls();
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
    // purge les références mortes (ex: re-render des murs)
    Array.from(selection).forEach(n => { if (!n.isConnected) selection.delete(n); });

    // applique le style sélectionné à tout : cartes, meubles et murs
    $stage.querySelectorAll('.pc_card, .pc_furn, #pc_svg .wall').forEach(n => {
      n.classList.toggle('pc_selected', selection.has(n));
    });
  }


  function nudgeSelection(dxPx, dyPx) {
    if (!selection.size) return;

    let movedWall = false;

    selection.forEach(n => {
      // déplacement visuel si élément HTML (cartes/meubles)
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
        // --- élève
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
        // --- meuble
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

          f.x = snapUnits(gx - pxAdj.dx);
          f.y = snapUnits(gy - pxAdj.dy);
          f.w = gw; f.h = gh;
        }
      } else if (isWall) {
        // --- mur (polyline SVG) : translation des points
        const wallId = n.dataset.wallId;
        const w = state.walls.find(W => String(W.id) === String(wallId));
        if (!w || !Array.isArray(w.points)) return;

        // conversion px -> unités
        let du = dxPx / unitPx;
        let dv = dyPx / unitPx;

        // clamp pour rester dans le plan
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
          // MAJ DOM immédiate
          n.setAttribute('points', w.points.map(p => `${toPx(p.x)},${toPx(p.y)}`).join(' '));
          movedWall = true;
        }
      }
    });

    autosavePositions();
    autosaveFurniture();
    if (movedWall) autosaveWalls();
  }


  // Construit le rectangle "effectif" d'un objet stocké par son coin haut-gauche
  // quand il est potentiellement tourné à 90°/270° : on recentre pour garder le centre.
  function rectFromTopLeftWithRotation(x, y, w, h, rot) {
    const swap = isQuarterTurnSwap(rot);
    const wEff = swap ? h : w;
    const hEff = swap ? w : h;
    const dx = swap ? (w - wEff) / 2 : 0;   // en unités
    const dy = swap ? (h - hEff) / 2 : 0;   // en unités
    return { x: snapUnits(x + dx), y: snapUnits(y + dy), w: wEff, h: hEff };
  }

  // Corrige un (left/top) exprimé en PIXELS si l'objet est à 90°/270°.
  // - leftPx/topPx : position coin haut-gauche en px (comme dans le style CSS)
  // - w/h : dimensions stockées en unités (non tournées)
  // Retourne aussi dx/dy en unités (offset appliqué) pour reconvertir au stockage.
  function adjustClientPxForSwap(leftPx, topPx, w, h, rot) {
    const swap = isQuarterTurnSwap(rot);
    if (!swap) return { leftPx, topPx, wEff: w, hEff: h, dx: 0, dy: 0 };
    const wEff = h, hEff = w;               // dimensions effectives en unités
    const dx = (w - wEff) / 2;
    const dy = (h - hEff) / 2;
    return {
      leftPx: leftPx + toPx(dx),
      topPx: topPx + toPx(dy),
      wEff, hEff, dx, dy
    };
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

  function restoreWallsForPlan() {
    if (!state.active_plan) return;
    const planId = state.active_plan.id;

    // 1) Si l’API a déjà rempli state.walls → OK
    if (Array.isArray(state.walls) && state.walls.length) {
      renderWalls();
      return;
    }

    // 2) Fallback localStorage (format ENCODÉ) → DECODE
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

      // 1) Récupération API (le plan demandé, sinon actif / plus récent)
      const data = await api.getAll(planIdToShow);
      console.log('[API positions sample]', (data.positions || [])[0]);

      const plans = Array.isArray(data.plans) ? data.plans : [];
      const eleves = Array.isArray(data.eleves) ? data.eleves : [];
      const seats = Array.isArray(data.seats) ? data.seats : [];
      const apiWallsEnc = Array.isArray(data.walls) ? data.walls : []; // murs encodés côté serveur

      // 2) Sélection du plan à afficher (conservateur : garde si possible l'actuel)
      const pickActivePlan = (plans, currentActive, apiActive) => {
        if (apiActive) return apiActive;
        if (currentActive) {
          const keep = plans.find(p => p.id === currentActive.id);
          if (keep) return keep;
        }
        return plans[0] || null;
      };
      const active_plan = pickActivePlan(plans, state.active_plan, data.active_plan);

      // 3) Réinitialise les subdivisions (cohérence avec le reste de ton code)
      PLAN_SUBDIV = 32;
      UI_SUBDIV = 32;

      // 4) Positions élèves (→ unités)
      const positions = Array.isArray(data.positions) ? data.positions.map(fromDBPosition) : [];

      // 5) Meubles : préserver les couleurs locales si l’API n’en renvoie pas
      //    + remapper rotation/coords en unités
      const prevTmpByUid = new Map((state.furniture || []).filter(ff => ff && ff.id < 0 && ff.uid).map(ff => [ff.uid, ff]));
      const prevColorById = new Map((state.furniture || []).filter(ff => ff && ff.id > 0).map(ff => [ff.id, ff.color]));

      const furniture = (Array.isArray(data.furniture) ? data.furniture : []).map(f => {
        const rot = Number(f.rotation || 0);

        // couleur: priorité = API > localStorage > ancien tmp (client_uid) > palette type > null
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

      // 6) Murs : **decode** depuis l’API (on garde le state en unités)
      const walls = decodeWallsFromStorage(apiWallsEnc);

      // 7) Commit état
      state = { ...state, plans, active_plan, eleves, positions, furniture, seats, walls };
      sentNewFurniture.clear();

      // 8) Rendu + fallback murs localStorage si l’API n’a rien renvoyé
      render();
      restoreWallsForPlan(); // si API vide, on recharge pc_walls_<planId> (encodé) puis decode
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
  $sel?.addEventListener('change', async () => {
    const id = parseInt($sel.value, 10);
    if (!Number.isFinite(id)) return;
    await api.activate(id);  // modifie is_active en BDD
    await boot(id);          // recharge l’affichage
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
      // ✅ Recharge propre depuis le serveur pour rafraîchir la <select> et l’état complet
      await boot();                                // <-- re-fetch plans/active_plan/seats/...
      // optionnel : repositionner le select sur le premier plan dispo
      if (sel && state.active_plan) {
        sel.value = String(state.active_plan.id);
        sel.dispatchEvent(new Event('change'));
      }
      window.dispatchEvent(new CustomEvent('seating:plan:deleted', { detail: { planId, serverOK } }));
      if (!serverOK) console.warn('[Plan] Suppression : serveur non confirmé (mais état rechargé).');

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

  // SUPPRIMER ce bloc inutile, ou corriger ainsi si tu veux t’en servir :
  async function onClickDeletePlan() {
    if (!state.active_plan) return;
    // Réutilise l’API existante qui marche déjà :
    await api.reset(state.active_plan.id, true); // ou api.delete si tu en as un
    await boot();
  }

  async function refreshPlansFromServer() {
    const url = `${API_BASE}/plans/${conf.classeId}`; // ex: /seating/api/plans/123
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`GET plans failed: ${r.status}`);
    const data = await r.json();

    state.plans = data.plans || [];
    state.active_plan = data.active_plan || null;
    state.seats = data.seats || [];
    state.furniture = data.furniture || [];
    state.positions = data.positions || [];
    state.eleves = data.eleves || [];
  }



  // INIT
  boot().catch(console.error);
  setupFullscreenExact($wrap, fitStageToWrap, render);


})();