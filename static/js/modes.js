// @ts-nocheck
"use strict";
(function () {
    if (window.__modes_anim_installed__) return;
    window.__modes_anim_installed__ = true;

    const EASE_IN = 'cubic-bezier(.22,.61,.36,1)', EASE_OUT = 'cubic-bezier(.4,0,.2,1)';
    const DUR_IN = 220, DUR_OUT = 180, PANEL_ID = 'mode-panel';
    let navInProgress = false;
    const CAN = !!(Element.prototype && Element.prototype.animate);

    function frames(kind, dir) {
        const IN = {
            fade: [{ opacity: 0 }, { opacity: 1 }],
            slide: [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
            wipe: [{ 'clip-path': 'inset(0 0 100% 0)' }, { 'clip-path': 'inset(0 0 0 0)' }],
        };
        const OUT = {
            fade: [{ opacity: 1 }, { opacity: 0 }],
            slide: [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-12px)' }],
            wipe: [{ 'clip-path': 'inset(0 0 0 0)' }, { 'clip-path': 'inset(0 0 100% 0)' }],
        };
        return (dir === 'in' ? IN : OUT)[kind] || (dir === 'in' ? IN.fade : OUT.fade);
    }

    function prefersReduced() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
    function cancelAll(p) { if (!p.getAnimations) return; try { p.getAnimations().forEach(a => a.cancel()); } catch (e) { } }

    function fadeIn(panel) {
        const kind = panel.getAttribute('data-anim') || 'fade';
        if (!CAN || prefersReduced()) { panel.style.opacity = '1'; panel.removeAttribute('data-enter'); return; }
        cancelAll(panel);
        panel.animate(frames(kind, 'in'), { duration: DUR_IN, easing: EASE_IN, fill: 'both' })
            .finished.finally(() => panel.removeAttribute('data-enter'));
    }

    function fadeOutAndGo(panel, href) {
        if (navInProgress) return; navInProgress = true;
        const kind = panel.getAttribute('data-anim') || 'fade';
        const go = () => location.assign(href);
        if (!CAN || prefersReduced()) { go(); return; }
        cancelAll(panel);
        panel.style.height = panel.offsetHeight + 'px';
        panel.style.overflow = 'hidden';
        panel.style.willChange = 'transform,opacity';
        const anim = panel.animate(frames(kind, 'out'), { duration: DUR_OUT, easing: EASE_OUT, fill: 'forwards' });
        const safety = setTimeout(go, DUR_OUT + 120);
        anim.finished.then(() => { clearTimeout(safety); go(); })
            .catch(() => { clearTimeout(safety); go(); });
    }

    window.addEventListener('DOMContentLoaded', () => {
        const panel = document.getElementById(PANEL_ID);
        if (panel) fadeIn(panel);
    }, { once: true });

    document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a.js-mode-link') : null;
        if (!a) return;
        const href = a.getAttribute('href'); if (!href) return;
        const panel = document.getElementById(PANEL_ID); if (!panel) return;
        e.preventDefault();
        fadeOutAndGo(panel, href);
    }, true);
})();
