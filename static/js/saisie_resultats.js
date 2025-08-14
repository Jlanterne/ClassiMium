// === Saisie résultats : moyenne + disquette save par ligne =================
(function () {
    const map = { "NA": 0, "PA": 2, "A": 4 };

    const form = document.getElementById('form-saisie-resultats');
    if (!form) return;

    function getRowValues(tr) {
        // 1) Selects (si présents)
        const selects = [...tr.querySelectorAll('.niv-select')];
        const values = selects.map(s => s.value).filter(v => v !== null);

        // 2) Sinon, pastilles (si utilisées)
        if (values.length === 0) {
            const pills = tr.querySelectorAll('.note-pills .pill.selected');
            if (pills.length) {
                // on mappe par objectif si tu as un data-objectif-id sur le parent (facultatif)
                return [...pills].map(p => (p.dataset.valeur || p.textContent || '').trim().toUpperCase());
            }
        }
        return values;
    }

    function calcRow(tr) {
        const vals = getRowValues(tr)
            .map(v => (v || '').toUpperCase())
            .filter(v => v && v !== '---' && map[v] !== undefined);

        const out = tr.querySelector('.moy, .moyenne-note');
        if (!out) return;

        if (vals.length === 0) {
            out.textContent = "—";
            return;
        }
        const sum = vals.reduce((s, v) => s + map[v], 0);
        const sur20 = (sum / vals.length) / 4 * 20;
        out.textContent = sur20.toFixed(1) + " / 20";
    }

    function recalcAll() {
        document.querySelectorAll('tr[data-eleve-id], tr.ligne-eleve').forEach(calcRow);
    }

    async function saveRow(tr) {
        // feedback visuel (disquette)
        const saver = tr.querySelector('.save-icon-moy');
        if (saver) { saver.classList.remove('show'); }

        // Construit un POST minimal compatible avec ta route
        const fd = new FormData();
        const csrf = form.querySelector('input[name="csrf_token"]');
        if (csrf) fd.append('csrf_token', csrf.value);

        // identifiant élève visible (pour la partie absences côté serveur)
        const eleveId = tr.getAttribute('data-eleve-id') || tr.querySelector('input[name="eleve[]"]')?.value;
        if (eleveId) fd.append('eleve[]', eleveId);

        // absent ?
        const chk = tr.querySelector('input[type="checkbox"][name^="absent_"]');
        if (chk && chk.checked) fd.append(`absent_${eleveId}`, 'on');

        // selects
        tr.querySelectorAll('.niv-select[name^="resultat_"]').forEach(sel => {
            fd.append(sel.name, sel.value || '');
        });

        // Si tu utilises des pastilles au lieu des selects, ajoute leur payload ici (facultatif)
        // Exemple: name="resultat_<eleve>_<objectif>"
        tr.querySelectorAll('.note-pills[data-eleve][data-objectif]').forEach(group => {
            const el = group.dataset.eleve;
            const obj = group.dataset.objectif;
            const selected = group.querySelector('.pill.selected');
            const val = (selected?.dataset.valeur || '').toUpperCase();
            if (el && obj) fd.append(`resultat_${el}_${obj}`, val);
        });

        try {
            const resp = await fetch(form.action, { method: 'POST', body: fd });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            if (saver) {
                saver.classList.add('show');
                setTimeout(() => saver && saver.classList.remove('show'), 1200);
            }
        } catch (e) {
            console.error('Save row error:', e);
        }
    }

    // init
    recalcAll();

    // Changement selects => recalc
    document.addEventListener('change', (e) => {
        if (e.target.matches('.niv-select')) {
            const tr = e.target.closest('tr[data-eleve-id], tr.ligne-eleve');
            if (tr) calcRow(tr);
        }
    });

    // Click pastilles => toggle + recalc
    document.addEventListener('click', (e) => {
        const pill = e.target.closest('.note-pills .pill');
        if (!pill) return;
        const group = pill.closest('.note-pills');
        if (!group) return;
        // une seule pastille active par groupe
        group.querySelectorAll('.pill').forEach(p => p.classList.remove('selected'));
        pill.classList.add('selected');
        const tr = pill.closest('tr[data-eleve-id], tr.ligne-eleve');
        if (tr) calcRow(tr);
    });

    // Disquette (dans la colonne Moyenne)
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-save-row, .save-icon, .save-icon-moy');
        if (!btn) return;
        const tr = btn.closest('tr[data-eleve-id], tr.ligne-eleve');
        if (tr) saveRow(tr);
    });

    // Absent => grise la ligne + vide visuellement les selects (sans POST auto)
    document.addEventListener('change', (e) => {
        if (!e.target.matches('input[type="checkbox"][name^="absent_"]')) return;
        const tr = e.target.closest('tr[data-eleve-id], tr.ligne-eleve');
        if (!tr) return;
        if (e.target.checked) {
            tr.classList.add('absent');
            tr.querySelectorAll('.niv-select').forEach(s => s.value = "");
            tr.querySelectorAll('.note-pills .pill').forEach(p => p.classList.remove('selected'));
        } else {
            tr.classList.remove('absent');
        }
        calcRow(tr);
    });

})();
