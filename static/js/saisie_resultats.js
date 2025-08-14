document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('form-resultats');

    // Barème NA/PA/A
    const PTS = { 'NA': 0, 'PA': 2, 'A': 4 };

    // Palette dictées pour la moyenne
    const COLOR = {
        'NA': '#ff000075', 'PA-': '#ff7d1aa6', 'PA': '#ffe223', 'PA+': '#d4f5b0',
        'A-': '#a7e9b7', 'A': '#5cc995', 'A+': '#3dbcb9', 'D': '#00d3f8'
    };

    function appreciation(note20) {
        if (note20 === 20) return 'D';
        if (note20 > 16 && note20 < 20) return 'A+';
        if (note20 > 13 && note20 <= 16) return 'A';
        if (note20 >= 12 && note20 <= 13) return 'PA+';
        if (note20 >= 8 && note20 < 12) return 'PA';
        if (note20 >= 6 && note20 < 8) return 'PA-';
        return 'NA';
    }

    function renderMoyenneRow(tr) {
        const note = tr.querySelector('.moyenne-note');
        const badge = tr.querySelector('.pill-moy');
        if (!note || !badge) return;

        // Absent → pas d’affichage de moyenne
        if (tr.classList.contains('absent')) {
            note.textContent = '';
            badge.textContent = '';
            badge.style.backgroundColor = '';
            badge.style.color = '#000';
            badge.classList.remove('selected');
            return;
        }

        // Calcul à partir des hidden inputs
        const hidden = tr.querySelectorAll('input[type="hidden"][name^="resultat_"]');
        let sum = 0, n = 0;
        hidden.forEach(h => {
            const v = (h.value || '').toUpperCase();
            if (v in PTS) { sum += PTS[v]; n++; }
        });

        if (n === 0) {
            note.textContent = '';
            badge.textContent = '';
            badge.style.backgroundColor = '';
            badge.style.color = '#000';
            badge.classList.remove('selected');
            return;
        }

        const avg = sum / n;            // 0..4
        const note20 = (avg / 4) * 20;  // /20
        const app = appreciation(note20);

        note.textContent = `${note20.toFixed(1)} / 20`;
        badge.textContent = app;
        badge.style.backgroundColor = COLOR[app] || '#ddd';
        badge.style.color = '#000';
        badge.classList.add('selected'); // même rendu que pastilles objectifs
    }

    function renderAll() {
        document.querySelectorAll('tr.ligne-eleve').forEach(renderMoyenneRow);
    }

    // autosave : POST du formulaire entier, disquette 1s UNIQUEMENT à droite de la moyenne
    let saveTimer = null;
    function autoSave(rowElem) {
        if (saveTimer) clearTimeout(saveTimer);

        const icon = rowElem?.querySelector('.save-icon-moy');
        if (icon) {
            icon.classList.remove('show');
            // reflow pour relancer l’animation
            // eslint-disable-next-line no-unused-expressions
            icon.offsetWidth;
        }

        saveTimer = setTimeout(() => {
            fetch(form.action, { method: 'POST', body: new FormData(form) })
                .then(() => { if (icon) icon.classList.add('show'); })
                .catch(() => { });
        }, 160);
    }

    // Clic sur pastilles NA/PA/A
    document.querySelectorAll('.note-cell .pill').forEach(btn => {
        btn.addEventListener('click', () => {
            const td = btn.closest('.note-cell');
            const tr = btn.closest('tr.ligne-eleve');
            if (!td || !tr || tr.classList.contains('absent')) return;

            // sélection unique
            td.querySelectorAll('.pill').forEach(p => p.classList.remove('selected'));
            btn.classList.add('selected');

            // MAJ hidden
            const hidden = td.querySelector('input[type="hidden"][name^="resultat_"]');
            if (hidden) hidden.value = btn.dataset.val || btn.getAttribute('data-val');

            // recalcul moyenne + autosave (icône côté moyenne)
            renderMoyenneRow(tr);
            autoSave(tr);
        });
    });

    // Absence : grise la ligne, désactive pastilles, efface la moyenne affichée
    document.querySelectorAll('.absent-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
            const tr = cb.closest('tr.ligne-eleve');
            if (!tr) return;

            if (cb.checked) {
                tr.classList.add('absent');
                tr.querySelectorAll('.note-pills').forEach(g => g.classList.add('disabled'));
            } else {
                tr.classList.remove('absent');
                tr.querySelectorAll('.note-pills').forEach(g => g.classList.remove('disabled'));
            }

            renderMoyenneRow(tr);
            autoSave(tr);
        });
    });

    // Init (F5) – on relit les valeurs déjà injectées par Jinja
    renderAll();
});
