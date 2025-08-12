// @ts-nocheck
"use strict";
(function () {
    if (window.__modes_anim_installed__) return;
    window.__modes_anim_installed__ = true;

    const html = document.documentElement;
    const UI = window.UI || {};
    const CAN = !!(Element.prototype && Element.prototype.animate);
    let navInProgress = false;

    /* --- STRATÉGIE DE NAVIGATION (réduire le délai perçu) --- */
    // 'instant' = navigation immédiate (zéro délai) ; 'early' = ~35% de l'outro ; 'end' = à la fin
    const NAV_STRATEGY = 'early';
    const NAV_EARLY_FRACTION = 0.35; // 0.20..0.40 = très réactif
    const NAV_EARLY_MIN_MS = 40;

    /* ----------------------- Utils ----------------------- */
    function clamp(n, min, max) { return Math.max(min, Math.min(n, max)); }
    function prefersReduced() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
    function cancelAll(el) { if (!el?.getAnimations) return; try { el.getAnimations().forEach(a => a.cancel()); } catch (e) { } }

    /* ----------------- Préférences (BDD/HTML) ----------------- */
    const CHOICES = [
        'fade',
        'slide-up', 'slide-down', 'slide-left', 'slide-right',
        'wipe-up', 'wipe-down', 'wipe-left', 'wipe-right',
        'curtain-h', 'curtain-v',
        'clip-circle', 'clip-ellipse',
        'zoom-in', 'zoom-out', 'scale-pop',
        'flip-x', 'flip-y', 'hinge-top',
        'skew-in', 'rotate-in', 'newspaper',
        'blur-in', 'blur-zoom'
    ];
    function pickRandom() { return CHOICES[(Math.random() * CHOICES.length) | 0]; }

    function getAnimKind(panel) {
        let k = panel?.getAttribute('data-anim') || html.dataset.animMode || UI.anim_mode || 'fade';
        if (k === 'random') k = pickRandom();
        return CHOICES.includes(k) ? k : 'fade';
    }
    function getDurations() {
        const base = Number(html.dataset.animDuration || UI.anim_duration || 520);
        const BASE = Number.isFinite(base) ? clamp(base, 160, 1600) : 520;
        // plus vif que la version précédente
        const computedOut = Math.round(BASE * 0.28); // ex. 520 → 146
        const computedIn = Math.round(BASE * 0.50); // ex. 520 → 260
        const DUR_OUT = clamp(computedOut, 90, 160);
        const DUR_IN = clamp(computedIn, 160, 280);
        return { DUR_IN, DUR_OUT };
    }

    /* -------------------- Keyframes -------------------- */
    function frames(kind, dir) {
        const show = (a, b) => dir === 'in' ? [a, b] : [b, a];

        switch (kind) {
            /* basiques */
            case 'fade': return show({ opacity: 0 }, { opacity: 1 });
            case 'slide-up': return show({ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' });
            case 'slide-down': return show({ opacity: 0, transform: 'translateY(-12px)' }, { opacity: 1, transform: 'translateY(0)' });
            case 'slide-left': return show({ opacity: 0, transform: 'translateX(16px)' }, { opacity: 1, transform: 'translateX(0)' });
            case 'slide-right': return show({ opacity: 0, transform: 'translateX(-16px)' }, { opacity: 1, transform: 'translateX(0)' });

            /* wipes directionnels (rideaux simples) – inset(top right bottom left) */
            case 'wipe-down': return show({ clipPath: 'inset(0 0 100% 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });
            case 'wipe-up': return show({ clipPath: 'inset(100% 0 0 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });
            case 'wipe-right': return show({ clipPath: 'inset(0 100% 0 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });
            case 'wipe-left': return show({ clipPath: 'inset(0 0 0 100%)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });

            /* rideaux “théâtre” (ouvre depuis le centre) */
            case 'curtain-h': return show({ clipPath: 'inset(0 50% 0 50%)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });
            case 'curtain-v': return show({ clipPath: 'inset(50% 0 50% 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });

            /* clips arrondis */
            case 'clip-circle': return show({ opacity: 0, clipPath: 'circle(0% at 50% 40%)' }, { opacity: 1, clipPath: 'circle(140% at 50% 40%)' });
            case 'clip-ellipse': return show({ opacity: 0, clipPath: 'ellipse(20% 8% at 50% 35%)' }, { opacity: 1, clipPath: 'ellipse(120% 75% at 50% 35%)' });

            /* zooms / scales */
            case 'zoom-in': return show({ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'scale(1)' });
            case 'zoom-out': return show({ opacity: 0, transform: 'scale(1.08)' }, { opacity: 1, transform: 'scale(1)' });
            case 'scale-pop': return show({ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'scale(1)' });

            /* 3D / flips (perspective requise côté CSS) */
            case 'flip-x': return show({ opacity: 0, transform: 'rotateX(-90deg)' }, { opacity: 1, transform: 'rotateX(0)' });
            case 'flip-y': return show({ opacity: 0, transform: 'rotateY(90deg)' }, { opacity: 1, transform: 'rotateY(0)' });
            case 'hinge-top': return show({ opacity: 0, transformOrigin: 'top', transform: 'rotateX(-35deg)' }, { opacity: 1, transformOrigin: 'top', transform: 'rotateX(0)' });

            /* stylées / fun */
            case 'skew-in': return show({ opacity: 0, transform: 'skewY(6deg) translateY(-8px)' }, { opacity: 1, transform: 'skewY(0) translateY(0)' });
            case 'rotate-in': return show({ opacity: 0, transform: 'rotate(-8deg) scale(.98)' }, { opacity: 1, transform: 'rotate(0) scale(1)' });
            case 'newspaper': return show({ opacity: 0, transform: 'rotate(-540deg) scale(0.2)' }, { opacity: 1, transform: 'rotate(0) scale(1)' });

            /* filtres */
            case 'blur-in': return show({ opacity: 0, filter: 'blur(10px)' }, { opacity: 1, filter: 'blur(0)' });
            case 'blur-zoom': return show({ opacity: 0, transform: 'scale(.96)', filter: 'blur(12px)' }, { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' });

            default: return show({ opacity: 0 }, { opacity: 1 });
        }
    }


    /* ------------------ Entrée / Sortie ------------------ */
    function fadeIn(panel) {
        const kind = getAnimKind(panel);
        const { DUR_IN } = getDurations();
        if (kind === 'none' || !CAN || prefersReduced()) {
            panel.style.opacity = '1';
            panel.removeAttribute('data-enter');
            return;
        }
        cancelAll(panel);
        const anim = panel.animate(frames(kind, 'in'), { duration: DUR_IN, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' });
        // figer l'état final proprement si dispo
        anim.finished.finally(() => { try { anim.commitStyles?.(); anim.cancel(); } catch { } panel.removeAttribute('data-enter'); });
    }

    function fadeOutAndNavigate(panel, navigate) {
        const kind = getAnimKind(panel);
        const { DUR_OUT } = getDurations();
        if (navInProgress) return;
        navInProgress = true;

        if (NAV_STRATEGY === 'instant' || kind === 'none' || !CAN || prefersReduced()) {
            try { navigate(); } catch { location.reload(); }
            return;
        }

        let done = false;
        const go = () => { if (done) return; done = true; try { navigate(); } catch { location.reload(); } };

        cancelAll(panel);
        panel.style.height = panel.offsetHeight + 'px'; // anti-saut
        panel.style.overflow = 'hidden';
        panel.style.willChange = 'transform,opacity,clip-path';

        const anim = panel.animate(frames(kind, 'out'), { duration: DUR_OUT, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });

        if (NAV_STRATEGY === 'early') {
            const NAV_AT = Math.max(NAV_EARLY_MIN_MS, Math.min(Math.round(DUR_OUT * NAV_EARLY_FRACTION), DUR_OUT - 20));
            const early = setTimeout(go, NAV_AT);
            const safety = setTimeout(go, DUR_OUT + 150);
            anim.finished.then(() => { clearTimeout(early); clearTimeout(safety); go(); })
                .catch(() => { clearTimeout(early); clearTimeout(safety); go(); });
        } else {
            const safety = setTimeout(go, DUR_OUT + 120);
            anim.finished.then(() => { clearTimeout(safety); go(); })
                .catch(() => { clearTimeout(safety); go(); });
        }
    }

    /* -------------------- Prefetch -------------------- */
    const _prefetched = new Set();
    function prefetchDoc(href) {
        if (!href || _prefetched.has(href)) return;
        _prefetched.add(href);
        const l = document.createElement('link');
        l.rel = 'prefetch';
        l.as = 'document';
        l.href = href;
        document.head.appendChild(l);
    }
    function formGetURL(form) {
        const url = new URL(form.action, location.href);
        const fd = new FormData(form);
        for (const [k, v] of fd) if (v != null && v !== '') url.searchParams.set(k, v);
        return url.href;
    }

    /* -------------------- Hooks -------------------- */
    window.addEventListener('DOMContentLoaded', () => {
        const panel = document.getElementById('mode-panel');
        if (panel) fadeIn(panel);
    }, { once: true });

    window.addEventListener('pageshow', (e) => {
        if (e.persisted) {
            const panel = document.getElementById('mode-panel');
            if (panel) fadeIn(panel);
        }
    });

    // Prefetch liens & formulaires GET (barre d’actions)
    (function setupPrefetch() {
        document.querySelectorAll('a.js-mode-link').forEach(a => {
            const href = a.getAttribute('href');
            ['mouseenter', 'focus', 'touchstart', 'pointerdown', 'mousedown'].forEach(ev => {
                a.addEventListener(ev, () => prefetchDoc(href), { once: true, passive: true });
            });
        });
        document.querySelectorAll('.actions-classe form[method="get"]').forEach(f => {
            const btn = f.querySelector('button,[type=submit]');
            if (!btn) return;
            ['mouseenter', 'focus', 'touchstart', 'pointerdown', 'mousedown'].forEach(ev => {
                btn.addEventListener(ev, () => prefetchDoc(formGetURL(f)), { once: true, passive: true });
            });
        });
    })();

    // Sortie → navigation : liens de modes
    document.addEventListener('click', (e) => {
        const a = e.target?.closest ? e.target.closest('a.js-mode-link') : null;
        if (!a) return;
        const href = a.getAttribute('href'); if (!href) return;
        const panel = document.getElementById('mode-panel'); if (!panel) return;
        e.preventDefault();
        fadeOutAndNavigate(panel, () => location.assign(href));
    }, true);

    // Sortie → navigation : formulaires GET dans .actions-classe
    document.addEventListener('submit', (e) => {
        const form = e.target?.closest ? e.target.closest('.actions-classe form') : null;
        if (!form) return;
        if ((form.method || 'GET').toUpperCase() !== 'GET') return;
        const panel = document.getElementById('mode-panel'); if (!panel) return;
        e.preventDefault();
        const href = formGetURL(form);
        fadeOutAndNavigate(panel, () => location.assign(href));
    }, true);

})();
