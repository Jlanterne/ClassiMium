/* throw-to-trash.js — effet "jeter à la corbeille" façon mac */
(function (global) {
    "use strict";

    // Détections robustes
    const CAN_WAAPI =
        !!(global.Element && global.Element.prototype && global.Element.prototype.animate);

    const CAN_MOTION =
        CAN_WAAPI &&
        typeof global.CSS !== "undefined" &&
        typeof global.CSS.supports === "function" &&
        (global.CSS.supports("offset-path", 'path("M0,0 L1,1")') ||
            global.CSS.supports("offset-path", "path('M 0 0 L 1 1')"));

    function prefersReduced() {
        try { return global.matchMedia("(prefers-reduced-motion: reduce)").matches; }
        catch { return false; }
    }

    function rectCenter(el) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }

    function makeGhost(fromEl) {
        const g = fromEl.cloneNode(true);
        const c = rectCenter(fromEl);
        Object.assign(g.style, {
            position: "fixed",
            left: `${c.x}px`,
            top: `${c.y}px`,
            transform: "translate(-50%, -50%)",
            margin: 0,
            pointerEvents: "none",
            zIndex: 4000,
            filter: "drop-shadow(0 10px 18px rgba(0,0,0,.18))",
            willChange: "transform, opacity, offset-path",
            width: `${Math.max(8, c.w)}px`
        });
        document.body.appendChild(g);
        return g;
    }

    function pulse(el, dur = 280) {
        if (!CAN_WAAPI || !el) return;
        try {
            el.animate(
                [{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }],
                { duration: dur, easing: "cubic-bezier(.22,.61,.36,1)" }
            );
        } catch { /* ignore */ }
    }

    function cancelAll(el) {
        try { el && el.getAnimations && el.getAnimations().forEach(a => a.cancel()); } catch { }
    }

    function fallbackKeyframes(ghost, start, cfg) {
        const { end, ctrlX, ctrlY, rotate, duration, easingOut } = cfg;
        const dx1 = ctrlX - start.x, dy1 = ctrlY - start.y;
        const dx2 = end.x - start.x, dy2 = end.y - start.y;
        const kf = [
            { transform: "translate(-50%,-50%) translate(0px,0px) scale(1) rotate(0deg)", opacity: 1 },
            { transform: `translate(-50%,-50%) translate(${dx1}px,${dy1}px) scale(.9) rotate(${-rotate / 2}deg)`, opacity: .95, offset: .6 },
            { transform: `translate(-50%,-50%) translate(${dx2}px,${dy2}px) scale(.35) rotate(${rotate}deg)`, opacity: .25 }
        ];
        const anim = ghost.animate(kf, { duration, easing: easingOut, fill: "forwards" });
        return Promise.resolve(anim.finished).catch(() => { });
    }

    /**
     * Lance l’élément vers la corbeille.
     * @param {HTMLElement} sourceEl
     * @param {HTMLElement} trashEl
     * @param {Object} opts { remove=true, rotate=22, duration=650, curveHeight=120 }
     */
    async function throwToTrash(sourceEl, trashEl, opts = {}) {
        const {
            remove = true,
            rotate = 22,
            duration = 650,
            curveHeight = 120,
            easingOut = "cubic-bezier(.22,.61,.36,1)"
        } = opts;

        if (!sourceEl || !trashEl) {
            console.warn("[throw-to-trash] sourceEl ou trashEl manquant");
            if (remove) sourceEl?.remove();
            return;
        }

        if (prefersReduced() || !CAN_WAAPI) {
            // Fallback simple
            try {
                sourceEl.style.transition = "opacity .22s ease, transform .22s ease";
                sourceEl.style.opacity = "0";
                sourceEl.style.transform = "scale(.98)";
            } catch { }
            await new Promise(r => setTimeout(r, 240));
            if (remove) sourceEl.remove();
            return;
        }

        const start = rectCenter(sourceEl);
        const end = rectCenter(trashEl);
        if (!start.w || !start.h || !end.w || !end.h) {
            // El invisible -> fallback rapide
            try {
                sourceEl.style.transition = "opacity .22s ease, transform .22s ease";
                sourceEl.style.opacity = "0";
                sourceEl.style.transform = "scale(.98)";
            } catch { }
            await new Promise(r => setTimeout(r, 240));
            if (remove) sourceEl.remove();
            return;
        }

        const ghost = makeGhost(sourceEl);

        const ctrlX = (start.x + end.x) / 2;
        const ctrlY = Math.min(start.y, end.y) - Math.max(curveHeight, start.h * 0.8);

        if (CAN_MOTION) {
            try {
                ghost.style.offsetPath = `path("M ${start.x} ${start.y} Q ${ctrlX} ${ctrlY} ${end.x} ${end.y}")`;
                ghost.style.offsetRotate = "auto";
                const anim = ghost.animate(
                    [
                        { offsetDistance: "0%", transform: "translate(-50%, -50%) scale(1) rotate(0deg)", opacity: 1 },
                        { offset: 0.6, transform: `translate(-50%, -50%) scale(.9) rotate(${-rotate / 2}deg)`, opacity: .95 },
                        { offsetDistance: "100%", transform: `translate(-50%, -50%) scale(.35) rotate(${rotate}deg)`, opacity: .25 }
                    ],
                    { duration, easing: easingOut, fill: "forwards" }
                );
                pulse(trashEl);
                await anim.finished;
            } catch (e) {
                await fallbackKeyframes(ghost, start, { end, ctrlX, ctrlY, rotate, duration, easingOut });
                pulse(trashEl);
            }
        } else {
            await fallbackKeyframes(ghost, start, { end, ctrlX, ctrlY, rotate, duration, easingOut });
            pulse(trashEl);
        }

        ghost.remove();
        if (remove) sourceEl.remove();
    }

    /**
     * Délégation optionnelle (aucune auto-installation).
     */
    function initThrowDelegation(cfg) {
        const {
            itemSelector = ".panel-card",
            buttonSelector = "[data-action='delete']",
            trashSelector = ".js-trash-target",
            before = null,
            after = null,
            remove = true
        } = cfg || {};

        document.addEventListener("click", async (e) => {
            const btn = e.target && e.target.closest(buttonSelector);
            if (!btn) return;

            const item = btn.closest(itemSelector);
            const trash = document.querySelector(trashSelector);
            if (!item || !trash) return;

            e.preventDefault();
            btn.disabled = true;
            try {
                if (before) {
                    const ok = await Promise.resolve(before(item));
                    if (ok === false) { btn.disabled = false; return; }
                }
                await throwToTrash(item, trash, { remove });
                after && after(item);
            } catch (err) {
                console.warn("[throw-to-trash] erreur", err);
            } finally {
                btn.disabled = false;
            }
        });
    }

    // Expose
    global.ThrowFX = { throwToTrash, initThrowDelegation };
})(window);
