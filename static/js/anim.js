(function () {
    const root = document.getElementById('view')
        || document.getElementById('page')
        || document.querySelector('[data-anim-scope]');

    if (!root) return;

    const body = document.body;
    const mode = (body.dataset.animMode || 'slide').toLowerCase();
    const dur = Math.max(100, Math.min(parseInt(body.dataset.animDuration || '520', 10), 2000));

    // Applique la durée via style inline pour que CSS suive
    root.style.transitionDuration = dur + 'ms';

    // Entrée initiale
    root.classList.add('in-' + mode);
    requestAnimationFrame(() => {
        root.classList.add('show');
        root.addEventListener('transitionend', () => {
            root.classList.remove('in-' + mode, 'show');
        }, { once: true });
    });

    // Intercepte les clics internes
    document.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (!a) return;

        // Pas d’anim pour les liens externes / anchors / download / target=_blank
        const isExternal = a.origin !== location.origin;
        const isAnchor = a.getAttribute('href') && a.getAttribute('href').startsWith('#');
        if (isExternal || isAnchor || a.target === '_blank' || a.hasAttribute('download') || a.dataset.noAnim === 'true') {
            return;
        }

        // Ne pas casser les contrôles/formulaires
        if (a.hasAttribute('data-no-anim')) return;

        e.preventDefault();
        const href = a.href;

        // Animation de sortie
        root.classList.add('out-' + mode);
        requestAnimationFrame(() => {
            root.classList.add('hide');
            setTimeout(() => { location.href = href; }, dur);
        });
    });

    // Animation quand on revient avec le bouton précédent/suivant
    window.addEventListener('pageshow', (ev) => {
        if (ev.persisted) {
            root.classList.remove('out-' + mode, 'hide');
            root.classList.add('in-' + mode);
            requestAnimationFrame(() => {
                root.classList.add('show');
                setTimeout(() => root.classList.remove('in-' + mode, 'show'), dur);
            });
        }
    });
})();
