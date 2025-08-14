document.addEventListener("DOMContentLoaded", () => {
    const rows = document.querySelectorAll(".table-resultats_d tbody tr");

    rows.forEach(row => {
        const absentCheckbox = row.querySelector(".absent-checkbox");
        const inputs = row.querySelectorAll(".note-input");
        const moyenneCell = row.querySelector(".moyenne-cell");

        // Gestion absent
        absentCheckbox.addEventListener("change", () => {
            if (absentCheckbox.checked) {
                row.classList.add("absent-row");
                inputs.forEach(i => {
                    i.value = "";
                    i.disabled = true;
                });
                moyenneCell.textContent = "---";
            } else {
                row.classList.remove("absent-row");
                inputs.forEach(i => i.disabled = false);
                calculerMoyenne(row);
            }
        });

        // Gestion saisie notes
        inputs.forEach(input => {
            input.addEventListener("input", () => {
                // Conversion rapide
                if (input.value.toLowerCase() === "n") input.value = "NA";
                if (input.value.toLowerCase() === "p") input.value = "PA";
                if (input.value.toLowerCase() === "a") input.value = "A";

                calculerMoyenne(row);
            });
        });
    });

    // Fonction calcul moyenne
    function calculerMoyenne(row) {
        const inputs = row.querySelectorAll(".note-input");
        const moyenneCell = row.querySelector(".moyenne-cell");
        let total = 0, count = 0;

        inputs.forEach(input => {
            let val = input.value.trim().toUpperCase();
            if (val === "NA") { total += 0; count++; }
            if (val === "PA") { total += 2; count++; }
            if (val === "A") { total += 4; count++; }
        });

        if (count > 0) {
            let moyenne20 = (total / (count * 4)) * 20;
            moyenneCell.textContent = moyenne20.toFixed(1);
        } else {
            moyenneCell.textContent = "-";
        }
    }
});
