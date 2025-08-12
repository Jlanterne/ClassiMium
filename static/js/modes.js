// @ts-nocheck
"use strict";
(function () {
    if (window.__modes_anim_installed__) return;
    window.__modes_anim_installed__ = true;

    const CAN = !!(Element.prototype && Element.prototype.animate);
    const html = document.documentElement;
    const UI = window.UI || {};

    // --- choix & alias (compat anciens réglages) ---
    const CHOICES = [
        'fade',
        'slide-up', 'slide-down', 'slide-left', 'slide-right',
        'wipe-up', 'wipe-down', 'wipe-left', 'wipe-right',
        'curtain-h', 'curtain-v',
        'clip-circle', 'clip-ellipse',
        'zoom-in', 'zoom-out', 'scale-pop',
        'flip-x', 'flip-y', 'hinge-top',
        'skew-in', 'rotate-in', 'newspaper',
        'blur-in', 'blur-zoom',
        'none'
    ];
    const ALIAS = { slide: 'slide-down', wipe: 'wipe-down', clip: 'clip-circle', scale: 'zoom-in' };

    function clamp(n, min, max) { return Math.max(min, Math.min(n, max)); }

    function getAnimKind(panel) {
        let k = panel?.getAttribute('data-anim') || html.dataset.animMode || UI.anim_mode || 'fade';
        if (k === 'random') {
            const pool = CHOICES.filter(x => x !== 'none');
            k = pool[Math.floor(Math.random() * pool.length)];
        }
        k = ALIAS[k] || k;
        return CHOICES.includes(k) ? k : 'fade';
    }

    function getDurations() {
        const base = Number(html.dataset.animDuration || UI.anim_duration || 520);
        const BASE = Number.isFinite(base) ? clamp(base, 160, 5000) : 520;
        // OUT court / IN plus long
        const DUR_OUT = clamp(Math.round(BASE * 0.28), 80, Math.max(80, BASE - 60));
        const DUR_IN = clamp(Math.round(BASE * 0.60), 120, Math.min(BASE + 200, 1200));
        return { DUR_IN, DUR_OUT };
    }

    function frames(kind, dir) {
        const show = (a, b) => dir === 'in' ? [a, b] : [b, a];
        switch (kind) {
            // basiques
            case 'fade': return show({ opacity: 0 }, { opacity: 1 });
            case 'slide-up': return show({ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' });
            case 'slide-down': return show({ opacity: 0, transform: 'translateY(-12px)' }, { opacity: 1, transform: 'translateY(0)' });
            case 'slide-left': return show({ opacity: 0, transform: 'translateX(16px)' }, { opacity: 1, transform: 'translateX(0)' });
            case 'slide-right': return show({ opacity: 0, transform: 'translateX(-16px)' }, { opacity: 1, transform: 'translateX(0)' });

            // wipes directionnels
            case 'wipe-down': return show({ clipPath: 'inset(0 0 100% 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });
            case 'wipe-up': return show({ clipPath: 'inset(100% 0 0 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });
            case 'wipe-right': return show({ clipPath: 'inset(0 100% 0 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });
            case 'wipe-left': return show({ clipPath: 'inset(0 0 0 100%)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });

            // rideaux “théâtre”
            case 'curtain-h': return show({ clipPath: 'inset(0 50% 0 50%)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });
            case 'curtain-v': return show({ clipPath: 'inset(50% 0 50% 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 });

            // clips arrondis
            case 'clip-circle': return show({ opacity: 0, clipPath: 'circle(0% at 50% 40%)' }, { opacity: 1, clipPath: 'circle(140% at 50% 40%)' });
            case 'clip-ellipse': return show({ opacity: 0, clipPath: 'ellipse(20% 8% at 50% 35%)' }, { opacity: 1, clipPath: 'ellipse(120% 75% at 50% 35%)' });

            // zoom/scale
            case 'zoom-in': return show({ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'scale(1)' });
            case 'zoom-out': return show({ opacity: 0, transform: 'scale(1.08)' }, { opacity: 1, transform: 'scale(1)' });
            case 'scale-pop': return show({ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'scale(1)' });

            // 3D / fun
            case 'flip-x': return show({ opacity: 0, transform: 'rotateX(-90deg)' }, { opacity: 1, transform: 'rotateX(0)' });
            case 'flip-y': return show({ opacity: 0, transform: 'rotateY(90deg)' }, { opacity: 1, transform: 'rotateY(0)' });
            case 'hinge-top': return show({ opacity: 0, transformOrigin: 'top', transform: 'rotateX(-35deg)' },
                { opacity: 1, transformOrigin: 'top', transform: 'rotateX(0)' });
            case 'skew-in': return show({ opacity: 0, transform: 'skewY(6deg) translateY(-8px)' },
                { opacity: 1, transform: 'skewY(0) translateY(0)' });
            case 'rotate-in': return show({ opacity: 0, transform: 'rotate(-8deg) scale(.98)' },
                { opacity: 1, transform: 'rotate(0) scale(1)' });
            case 'newspaper': return show({ opacity: 0, transform: 'rotate(-540deg) scale(.2)' },
                { opacity: 1, transform: 'rotate(0) scale(1)' });

            // filtres
            case 'blur-in': return show({ opacity: 0, filter: 'blur(10px)' }, { opacity: 1, filter: 'blur(0)' });
            case 'blur-zoom': return show({ opacity: 0, transform: 'scale(.96)', filter: 'blur(12px)' },
                { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' });

            case 'none': default: return show({ opacity: 1 }, { opacity: 1 });
        }
    }

    function prefersReduced() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } }
    function cancelAll(p) { if (!p?.getAnimations) return; try { p.getAnimations().forEach(a => a.cancel()); } catch { } }

    function fadeIn(panel) {
        const kind = getAnimKind(panel);
        const { DUR_IN } = getDurations();
        if (kind === 'none' || !CAN || prefersReduced()) {
            panel.style.opacity = '1';
            panel.removeAttribute('data-enter');
            return;
        }
        cancelAll(panel);
        panel.animate(frames(kind, 'in'), { duration: DUR_IN, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'both' })
            .finished.finally(() => panel.removeAttribute('data-enter'));
    }

    let navInProgress = false;
    function fadeOutAndGo(panel, href) {
        const kind = getAnimKind(panel);
        const { DUR_OUT } = getDurations();
        if (navInProgress) return;
        navInProgress = true;

        let navigated = false;
        const go = () => { if (navigated) return; navigated = true; location.assign(href); };

        if (kind === 'none' || !CAN || prefersReduced()) { go(); return; }

        cancelAll(panel);
        panel.style.height = panel.offsetHeight + 'px';
        panel.style.overflow = 'hidden';
        panel.style.willChange = 'transform,opacity,clip-path';

        const anim = panel.animate(frames(kind, 'out'), {
            duration: DUR_OUT, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards'
        });

        const NAV_AT = Math.max(80, Math.min(Math.round(DUR_OUT * 0.6), DUR_OUT - 20));
        const early = setTimeout(go, NAV_AT);
        const safety = setTimeout(go, DUR_OUT + 150);

        anim.finished.then(() => { clearTimeout(early); clearTimeout(safety); go(); })
            .catch(() => { clearTimeout(early); clearTimeout(safety); go(); });
    }

    // IN au chargement (y compris back/forward cache)
    window.addEventListener('DOMContentLoaded', () => {
        const panel = document.getElementById('mode-panel');
        if (panel) fadeIn(panel);
    }, { once: true });
    window.addEventListener('pageshow', e => {
        if (e.persisted) { const p = document.getElementById('mode-panel'); if (p) fadeIn(p); }
    });

    // OUT sur liens de modes (utilise la classe .js-mode-link)
    document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a.js-mode-link') : null;
        if (!a) return;
        const href = a.getAttribute('href'); if (!href) return;
        const panel = document.getElementById('mode-panel'); if (!panel) return;
        e.preventDefault();
        fadeOutAndGo(panel, href);
    }, true);

})();

