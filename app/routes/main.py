# app/routes/main.py — clean & harmonisé (1 seul Blueprint "main")
from flask import (
    Blueprint, render_template, request, redirect, url_for, flash, jsonify,
    current_app, abort, session, make_response
)
import os, io, csv, json
from datetime import datetime, date

import psycopg2
import psycopg2.extras
from werkzeug.utils import secure_filename

from app.utils import (
    get_db_connection,
    export_docx_best_effort,
    export_pdf_faithful,
    ensure_export_dir_for_rapport,
    get_ui_settings_from_db,
    set_ui_settings_in_db,
)
# --- Notes & helpers pour la fiche élève ---
SCORE_MAP = {'NA': 0, 'PA': 2, 'A': 4}   # '---' est ignoré

DEFAULT_COLOR_BY_MATIERE = {
    'Français': '#87cefa', 'Mathématiques': '#f4a460', 'QLM': '#98fb98',
    'Anglais': '#ff4500', 'EPS': '#ffff00', 'EMC': '#a9a9a9',
    'Arts plastiques': '#a0522d', 'Musique': '#7b68ee', 'Autres': '#607D8B'
}
DEFAULT_COLOR = '#607D8B'

def MATIERE_ORDER_COL(col="nom") -> str:
    return (
        f"CASE {col} "
        "WHEN 'Français' THEN 1 "
        "WHEN 'Mathématiques' THEN 2 "
        "WHEN 'QLM' THEN 3 "
        "WHEN 'Anglais' THEN 4 "
        "WHEN 'EMC' THEN 5 "
        "WHEN 'EPS' THEN 6 "
        "WHEN 'Musique' THEN 7 "
        "WHEN 'Arts plastiques' THEN 8 "
        "WHEN 'Autres' THEN 9 "
        "ELSE 99 END"
    )


def _to_date(d):
    if isinstance(d, date): return d
    if isinstance(d, datetime): return d.date()
    if isinstance(d, str):
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S"):
            try: return datetime.strptime(d, fmt).date()
            except ValueError: pass
    return None

def _niveau_depuis_note20(note20):
    if note20 is None: return None
    if note20 >= 20: return "D"
    if 16 < note20 < 20: return "A+"
    if 13 < note20 <= 16: return "A"
    if 12 <= note20 <= 13: return "PA+"
    if 8 <= note20 < 12: return "PA"
    if 6 <= note20 < 8: return "PA-"
    return "NA"

def _moyenne(l):
    return round(sum(l)/len(l), 1) if l else None

# ---- Valeurs par défaut sûres pour la page Config (évite NameError) ----
PRIMARY_ROOT     = os.getenv("DOCS_ROOT_PRIMARY",   r"Z:\Education Nationale")
SECONDARY_ROOT   = os.getenv("DOCS_ROOT_SECONDARY", r"\\Serveur\Documents\Education Nationale")
REUNIONS_DIRNAME = os.getenv("REUNIONS_DIRNAME",    "Réunions")
_ACTIVE_ROOT = None
_LAST_CHECK  = 0

bp = Blueprint("main", __name__)

@bp.get("/ping-session")
def ping_session():
    session['ping'] = session.get('ping', 0) + 1
    return f"ping={session['ping']}"


# On importe l'ancien module pour conserver ses utilitaires (si présents)
try:
    from app_legacy import *  # noqa
except Exception:
    pass

# Fallback pour allowed_file si non présent
if "allowed_file" not in globals():
    def allowed_file(filename):
        return "." in filename and filename.rsplit(".", 1)[1].lower() in {"png", "jpg", "jpeg", "gif", "webp"}

# ---------- Ordre canonique des niveaux ----------
def NIVEAU_ORDER_COL(col="niveau") -> str:
    """
    Retourne un CASE SQL qui ordonne CP, CE1, CE2, CM1, CM2.
    Usage: "ORDER BY " + NIVEAU_ORDER_COL('niveau')
    """
    return (
        f"CASE {col} "
        "WHEN 'CP' THEN 1 "
        "WHEN 'CE1' THEN 2 "
        "WHEN 'CE2' THEN 3 "
        "WHEN 'CM1' THEN 4 "
        "WHEN 'CM2' THEN 5 "
        "ELSE 99 END"
    )










# ---------- CSS généré ----------
@bp.route('/static/style.css')
def style_css():
    """Permet d'utiliser un template Jinja pour générer du CSS."""
    return render_template('style.css.j2'), 200, {'Content-Type': 'text/css'}

# ---------- Accueil ----------
@bp.route("/")
def index():
    """
    Accueil minimal (création de classe). La sidebar lit 'toutes_les_classes'.
    Si authentifié et qu'il existe au moins une classe, on redirige vers la plus récente.
    """
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("SELECT * FROM classes ORDER BY annee DESC")
    classes = cur.fetchall()

    # Si connecté → aller direct à la plus récente
    if session.get("auth") and classes:
        cls_id = classes[0]["id"]
        cur.close(); conn.close()
        return redirect(url_for("main.page_classe", classe_id=cls_id))

    # Ajoute niveaux triés pour chaque classe (pour la sidebar)
    for c in classes:
        cur.execute(
            "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
            (c["id"],)
        )
        c["niveaux"] = [row["niveau"] for row in cur.fetchall()]

    cur.close(); conn.close()
    return render_template("index.html", classes=classes, toutes_les_classes=classes)


from datetime import date, datetime

# ---------- Page classe ----------
@bp.route("/classe/<int:classe_id>")
def page_classe(classe_id):
    """
    Détail classe — modes :
      - ?mode=eleves (par défaut)
      - ?mode=liste_evaluations (+ filtres)
      - ?mode=saisie_resultats&evaluation_id=...
      - ?mode=ajouter_rapport
      - ?mode=ajouter_dictee
    """
    mode = request.args.get("mode", "eleves")
    evaluation_id = request.args.get("evaluation_id")
    filtre_niveau = request.args.get("filtre_niveau")
    filtre_matiere = request.args.get("filtre_matiere")
    filtre_sous_matiere = request.args.get("filtre_sous_matiere")

    niveaux_filtres = []
    groupes_dict = {}

    # Année scolaire courante
    now = datetime.now(); year = now.year; month = now.month
    annee_scolaire = f"{year}-{year + 1}" if month >= 8 else f"{year - 1}-{year}"

    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # ----- Niveaux de la classe (tri canonique) -----
    cur.execute(
        "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
        (classe_id,)
    )
    niveaux_classe = [row["niveau"] for row in cur.fetchall()]

    # ----- Toutes les classes (menu gauche) + niveaux triés -----
    cur.execute("SELECT * FROM classes ORDER BY annee DESC")
    toutes_les_classes = cur.fetchall()
    for cl in toutes_les_classes:
        cur.execute(
            "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
            (cl["id"],)
        )
        cl["niveaux"] = [row["niveau"] for row in cur.fetchall()]

    # ----- Classe courante -----
    cur.execute("SELECT * FROM classes WHERE id = %s", (classe_id,))
    classe = cur.fetchone()
    if not classe:
        cur.close(); conn.close()
        flash("Classe introuvable.")
        return redirect(url_for("main.index"))
    classe["niveaux"] = niveaux_classe

    # ---------- Données communes ----------
    # Élèves (triés par PRÉNOM puis NOM pour l'affichage)
    cur.execute("""
        SELECT id, nom, prenom, niveau, date_naissance
        FROM eleves
        WHERE classe_id = %s
        ORDER BY prenom ASC, nom ASC
    """, (classe_id,))
    eleves = cur.fetchall()

    # Matières & sous-matières (listes complètes)
    cur.execute("SELECT * FROM matieres ORDER BY nom")
    matieres = cur.fetchall()
    cur.execute("SELECT * FROM sous_matieres ORDER BY nom")
    sous_matieres = cur.fetchall()

    evaluations = []
    avancements = {}
    evaluation = objectifs = resultats = None
    eleves_par_niveau = None  # pour le mode 'ajouter_dictee'

    # ---------- Mode : liste des évaluations (+ filtres) ----------
    if mode == "liste_evaluations":
        requete = """
            SELECT e.id, e.titre, e.date, m.nom AS matiere, sm.nom AS sous_matiere
            FROM evaluations e
            LEFT JOIN matieres m ON e.matiere_id = m.id
            LEFT JOIN sous_matieres sm ON e.sous_matiere_id = sm.id
            WHERE e.classe_id = %s
        """
        params = [classe_id]

        if filtre_matiere:
            requete += " AND m.nom = %s"; params.append(filtre_matiere)
        if filtre_sous_matiere:
            requete += " AND sm.nom = %s"; params.append(filtre_sous_matiere)
        if filtre_niveau:
            requete += """
                AND EXISTS (
                    SELECT 1 FROM evaluations_niveaux en
                    WHERE en.evaluation_id = e.id AND en.niveau = %s
                )
            """
            params.append(filtre_niveau)

        requete += " ORDER BY e.date DESC"
        cur.execute(requete, params)
        evaluations = cur.fetchall()

        # Niveaux concernés par éval (tri canonique)
        for ev in evaluations:
            cur.execute(
                "SELECT niveau FROM evaluations_niveaux WHERE evaluation_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
                (ev["id"],)
            )
            ev["niveaux"] = [row["niveau"] for row in cur.fetchall()]

        # Filtres dynamiques — tri CP → CM2
        evaluation_ids = [e["id"] for e in evaluations]
        if evaluation_ids:
            cur.execute("""
                SELECT niveau
                FROM (
                    SELECT DISTINCT niveau
                    FROM evaluations_niveaux
                    WHERE evaluation_id = ANY(%s)
                ) x
                ORDER BY CASE x.niveau
                    WHEN 'CP'  THEN 1
                    WHEN 'CE1' THEN 2
                    WHEN 'CE2' THEN 3
                    WHEN 'CM1' THEN 4
                    WHEN 'CM2' THEN 5
                    ELSE 999
                END
            """, (evaluation_ids,))
            niveaux_filtres = [row["niveau"] for row in cur.fetchall()]
        else:
            niveaux_filtres = []

        # Avancement des saisies
        for ev in evaluations:
            cur.execute("SELECT COUNT(*) FROM objectifs WHERE evaluation_id = %s", (ev["id"],))
            nb_objectifs = cur.fetchone()["count"]

            total_attendus = nb_objectifs * len(eleves)
            if total_attendus == 0:
                avancements[ev["id"]] = 100
                continue

            cur.execute("SELECT * FROM resultats WHERE evaluation_id = %s", (ev["id"],))
            lignes = cur.fetchall()

            nb_complets = 0
            par_eleve = {}
            for r in lignes:
                par_eleve.setdefault(r["eleve_id"], {})[r["objectif_id"]] = r["niveau"]

            for el in eleves:
                reponses = par_eleve.get(el["id"], {})
                if len(reponses) == nb_objectifs and all(niv in ["NA", "PA", "A", "---"] for niv in reponses.values()):
                    nb_complets += 1

            progression = int((nb_complets / len(eleves)) * 100) if eleves else 0
            avancements[ev["id"]] = progression

    # ---------- Mode : saisie des résultats ----------
    if mode == "saisie_resultats" and evaluation_id:
        cur.execute("SELECT * FROM evaluations WHERE id = %s", (evaluation_id,))
        evaluation = cur.fetchone()

        cur.execute("SELECT * FROM objectifs WHERE evaluation_id = %s ORDER BY id", (evaluation_id,))
        objectifs = cur.fetchall()

        cur.execute("SELECT * FROM resultats WHERE evaluation_id = %s", (evaluation_id,))
        lignes = cur.fetchall()

        resultats = {eleve['id']: {} for eleve in eleves}
        for ligne in lignes:
            resultats[ligne["eleve_id"]][ligne["objectif_id"]] = ligne["niveau"]

    # ---------- Mode : ajouter rapport ----------
    types = []; sous_types = []; eleves_classe = []
    if mode == "ajouter_rapport":
        cur.execute("SELECT id, code, libelle FROM rapport_types ORDER BY libelle;")
        types = cur.fetchall()

        default_type_id = None
        for t in types:
            if t["code"] == "entretien_parents":
                default_type_id = t["id"]; break
        if default_type_id is None and types:
            default_type_id = types[0]["id"]

        if default_type_id:
            cur.execute("""
                SELECT id, code, libelle
                FROM rapport_sous_types
                WHERE type_id = %s
                ORDER BY libelle
            """, (default_type_id,))
            sous_types = cur.fetchall()

        cur.execute("""
            SELECT id, prenom, nom
            FROM eleves
            WHERE classe_id = %s
            ORDER BY prenom, nom
        """, (classe_id,))
        eleves_classe = cur.fetchall()

    # ---------- Mode : ajouter dictée ----------
    if mode == "ajouter_dictee":
        from collections import defaultdict
        eleves_par_niveau = {}
        ids_eleves = []

        for niveau in niveaux_classe:
            cur.execute("""
                SELECT * FROM eleves
                WHERE classe_id = %s AND niveau = %s
                ORDER BY nom
            """, (classe_id, niveau))
            eleves_niveau = cur.fetchall()
            eleves_par_niveau[niveau] = eleves_niveau
            ids_eleves.extend([e['id'] for e in eleves_niveau])

        cur.execute("""
            SELECT d.*
            FROM dictees d
            JOIN classes_niveaux cn ON cn.id = d.niveau_id
            WHERE cn.classe_id = %s
            ORDER BY d.date
        """, (classe_id,))
        dictees = cur.fetchall()
        dictees_bilan = [d for d in dictees if d.get('type') == 'bilan']

        # changements de groupe
        if ids_eleves:
            cur.execute("""
                SELECT eleve_id, groupe, date_changement
                FROM groupes_eleves
                WHERE eleve_id = ANY(%s)
                ORDER BY eleve_id, date_changement
            """, (ids_eleves,))
            changements_groupe = cur.fetchall()
        else:
            changements_groupe = []

        groupes_par_eleve = defaultdict(list)
        for row in changements_groupe:
            groupes_par_eleve[row['eleve_id']].append({
                'groupe': row['groupe'],
                'date': row['date_changement']
            })

        # groupe retenu à la date de chaque dictée bilan
        from collections import defaultdict as ddict
        groupes_dict = ddict(dict)
        for dictee in dictees_bilan:
            date_dictee = dictee['date']
            if isinstance(date_dictee, datetime):
                date_dictee = date_dictee.date()

            for eleve_id, changements in groupes_par_eleve.items():
                groupe = 'G3'
                for ch in changements:
                    ch_dt = ch['date']
                    if isinstance(ch_dt, datetime):
                        ch_dt = ch_dt.date()
                    if ch_dt <= date_dictee:
                        groupe = ch['groupe']
                    else:
                        break
                groupes_dict[eleve_id][date_dictee.isoformat()] = groupe

    # ---------- Colonnes MATIERES pour le tableau (mode=eleves) ----------
    # 👉 DEMANDE : voir **toutes** les matières, pas seulement celles avec évaluations.
    try:
        order_sql = MATIERE_ORDER_COL('nom')
    except Exception:
        order_sql = (
            "CASE nom "
            "WHEN 'Français' THEN 1 "
            "WHEN 'Mathématiques' THEN 2 "
            "WHEN 'QLM' THEN 3 "
            "WHEN 'Anglais' THEN 4 "
            "WHEN 'EMC' THEN 5 "
            "WHEN 'EPS' THEN 6 "
            "WHEN 'Musique' THEN 7 "
            "WHEN 'Arts plastiques' THEN 8 "
            "WHEN 'Autres' THEN 9 "
            "ELSE 99 END"
        )
    cur.execute("SELECT id, nom FROM matieres ORDER BY " + order_sql + ", nom")
    matieres_actives = cur.fetchall()

    # ---------- Moyennes /20 par élève × matière ----------
    # Mapping: 'NA'->0, 'PA'->10, 'A'->20 ; autres valeurs ignorées.
    cur.execute("""
        SELECT
            r.eleve_id,
            m.id   AS matiere_id,
            ROUND(AVG(
                CASE r.niveau
                    WHEN 'NA' THEN 0
                    WHEN 'PA' THEN 10
                    WHEN 'A'  THEN 20
                    ELSE NULL
                END
            )::numeric, 1) AS moyenne20
        FROM resultats r
        JOIN objectifs  o  ON o.id = r.objectif_id
        JOIN evaluations ev ON ev.id = o.evaluation_id
        JOIN matieres   m  ON m.id = ev.matiere_id
        WHERE ev.classe_id = %s
        GROUP BY r.eleve_id, m.id
    """, (classe_id,))
    rows_moy = cur.fetchall()

    # -> dict { eleve_id: { matiere_id: {"note": float, "pct": float} } }
    moyennes_par_matiere = {}
    for row in rows_moy:
        eid = row["eleve_id"]; mid = row["matiere_id"]
        note20 = row["moyenne20"]
        info = None
        if note20 is not None:
            pct = float(note20) * 5.0  # 0–100 (utile pour tes rubans NA/PA-/.../D si besoin)
            info = {"note": float(note20), "pct": pct}
        else:
            info = {"note": None, "pct": None}
        moyennes_par_matiere.setdefault(eid, {})[mid] = info

    cur.close(); conn.close()

    # Pour les anniversaires (🎂 dans le template)
    today_mmdd = date.today().strftime("%m-%d")

    return render_template(
        "classe.html",
        # Commun
        classe=classe,
        toutes_les_classes=toutes_les_classes,
        annee_scolaire=annee_scolaire,
        mode=mode,

        # Élèves + croisé matières
        eleves=eleves,
        matieres=matieres,
        sous_matieres=sous_matieres,
        matieres_actives=matieres_actives,             # ✅ colonnes = toutes les matières
        moyennes_par_matiere=moyennes_par_matiere,     # ✅ cellules (note /20 + pct)

        # Modes annexes
        evaluations=evaluations,
        avancements=avancements,
        evaluation=evaluation,
        objectifs=objectifs,
        resultats=resultats,
        niveaux_filtres=niveaux_filtres,
        eleves_par_niveau=eleves_par_niveau,
        groupes_dict=groupes_dict,
        types=locals().get("types", []),
        sous_types=locals().get("sous_types", []),
        eleves_classe=locals().get("eleves_classe", []),

        # Utilitaires template
        today_mmdd=today_mmdd,
    )



# ---------- API dictées ----------
@bp.post("/api/dictees")
def api_save_dictee():
    """
    Upsert d’une dictée + (optionnel) ses résultats.
    Payload minimal :
      { classe_id, niveau, date, type("simple"|"bilan"), ... }
    """
    data = request.get_json(silent=True) or {}
    conn = None; cur = None
    try:
        classe_id   = int(data.get("classe_id"))
        niveau_txt  = data.get("niveau")
        ddate       = data.get("date")                 # "YYYY-MM-DD" ou "YYYY-MM-DDTHH:MM"
        dtype       = data.get("type")                 # "simple" | "bilan"

        # Normalisation date -> datetime
        if isinstance(ddate, str):
            ddate = ddate.strip()
            try:
                if len(ddate) == 10:  # YYYY-MM-DD
                    ddate = datetime.fromisoformat(ddate + "T00:00:00")
                else:
                    ddate = datetime.fromisoformat(ddate.replace(" ", "T"))
            except ValueError:
                try:
                    ddate = datetime.strptime(ddate, "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    return jsonify(ok=False, error=f"Format de date invalide: {data.get('date')}"), 400
        elif not isinstance(ddate, datetime):
            return jsonify(ok=False, error="Champ 'date' manquant ou invalide"), 400

        if not (classe_id and niveau_txt and ddate and dtype in ("simple", "bilan")):
            return jsonify(ok=False, error="Payload incomplet ou invalide"), 400

        # savoir quelles clés sont présentes
        keys_present = set(data.keys())
        has_simple = "nb_mots_simple" in keys_present
        has_g1     = "nb_mots_g1"     in keys_present
        has_g2     = "nb_mots_g2"     in keys_present
        has_g3     = "nb_mots_g3"     in keys_present

        nb_simple = data.get("nb_mots_simple")
        nb_g1     = data.get("nb_mots_g1")
        nb_g2     = data.get("nb_mots_g2")
        nb_g3     = data.get("nb_mots_g3")

        resultats = data.get("resultats") or []
        if not isinstance(resultats, list):
            return jsonify(ok=False, error="`resultats` doit être une liste"), 400

        verrouille_payload = data.get("verrouille")

        conn = get_db_connection(); cur = conn.cursor()

        # 1) Résoudre niveau_id
        cur.execute("""
            SELECT cn.id
            FROM classes_niveaux cn
            WHERE cn.classe_id = %s AND cn.niveau = %s
            LIMIT 1
        """, (classe_id, niveau_txt))
        row = cur.fetchone()
        if not row:
            conn.rollback(); cur.close(); conn.close()
            return jsonify(ok=False, error=f"Niveau introuvable pour classe_id={classe_id}, niveau='{niveau_txt}'"), 404
        niveau_id = row[0]

        # 1bis) verrouille final
        dictee_id_payload = data.get("dictee_id")
        if dictee_id_payload:
            cur.execute("SELECT verrouille FROM dictees WHERE id = %s", (dictee_id_payload,))
            existing = cur.fetchone()
            existing_lock = existing[0] if existing else False
            verrouille_final = bool(verrouille_payload) if verrouille_payload is not None else existing_lock
        else:
            verrouille_final = bool(verrouille_payload) if verrouille_payload is not None else False

        # 2) Insert/Update dictée
        if dictee_id_payload:
            # UPDATE : conserver valeurs existantes si absentes du payload
            cur.execute("""
                SELECT nb_mots_simple, nb_mots_g1, nb_mots_g2, nb_mots_g3
                FROM dictees WHERE id = %s
            """, (dictee_id_payload,))
            row_existing = cur.fetchone()
            ex_simple, ex_g1, ex_g2, ex_g3 = row_existing if row_existing else (None, None, None, None)

            nb_simple_final = nb_simple if has_simple else ex_simple
            nb_g1_final     = nb_g1     if has_g1     else ex_g1
            nb_g2_final     = nb_g2     if has_g2     else ex_g2
            nb_g3_final     = nb_g3     if has_g3     else ex_g3

            sql = """
            UPDATE dictees
            SET niveau_id      = %s,
                date           = %s::date + (date::time),  -- change le JOUR, garde l'HEURE
                type           = %s,
                nb_mots_simple = %s,
                nb_mots_g1     = %s,
                nb_mots_g2     = %s,
                nb_mots_g3     = %s,
                verrouille     = %s,
                classe_id      = %s
            WHERE id = %s
            RETURNING id
            """
            params = (
                niveau_id, ddate, dtype,
                nb_simple_final, nb_g1_final, nb_g2_final, nb_g3_final,
                verrouille_final, classe_id, dictee_id_payload
            )
            cur.execute(sql, params)
            row = cur.fetchone()
            if not row:
                conn.rollback(); cur.close(); conn.close()
                return jsonify(ok=False, error=f"Dictée id={dictee_id_payload} introuvable pour update"), 404
            dictee_id = row[0]
            mode = "update"
        else:
            # INSERT
            date_dt = data.get("date_dt")  # peut être None
            sql = """
            INSERT INTO dictees (
              niveau_id, date, type,
              nb_mots_simple, nb_mots_g1, nb_mots_g2, nb_mots_g3,
              verrouille, classe_id
            ) VALUES (
              %s,
              COALESCE(
                %s::timestamptz AT TIME ZONE 'Europe/Paris',
                %s::date + (NOW() AT TIME ZONE 'Europe/Paris')::time
              ),
              %s, %s, %s, %s, %s, %s, %s
            )
            RETURNING id
            """
            params = (
                niveau_id, date_dt, ddate, dtype,
                nb_simple, nb_g1, nb_g2, nb_g3,
                verrouille_final, classe_id
            )
            cur.execute(sql, params)
            dictee_id = cur.fetchone()[0]
            mode = "insert"

        # 3) Upsert des résultats (si fournis)
        insert_sql = """
            INSERT INTO dictee_resultats (dictee_id, eleve_id, groupe, erreurs, nb_mots)
            VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (dictee_id, eleve_id) DO UPDATE
            SET groupe  = EXCLUDED.groupe,
                erreurs = EXCLUDED.erreurs,
                nb_mots = EXCLUDED.nb_mots
        """
        for r in resultats:
            eleve_id = r.get("eleve_id")
            if eleve_id is None:
                continue
            eleve_id = int(eleve_id)

            raw_err = r.get("erreurs")
            if raw_err in ("", None):
                erreurs = None
            else:
                try:
                    erreurs = int(raw_err)
                    if erreurs < 0:
                        erreurs = None
                except (TypeError, ValueError):
                    erreurs = None

            try:
                nb_mots_res = int(r.get("nb_mots") or 0)
                if nb_mots_res < 0:
                    nb_mots_res = 0
            except (TypeError, ValueError):
                nb_mots_res = 0

            groupe = r.get("groupe")  # "G1"/"G2"/"G3" ou None
            cur.execute(insert_sql, (dictee_id, eleve_id, groupe, erreurs, nb_mots_res))

        conn.commit()
        print(f"[api/dictees] COMMIT id={dictee_id} mode={mode}")
        cur.close(); conn.close()
        return jsonify(ok=True, dictee_id=dictee_id, mode=mode)

    except Exception as e:
        try:
            if conn: conn.rollback()
            if cur: cur.close()
            if conn: conn.close()
        except Exception:
            pass
        print(f"[api/dictees] ERROR: {e}")
        return jsonify(ok=False, error=str(e)), 500

@bp.get("/api/dictees")
def api_list_dictees():
    """Liste des dictées + résultats, pour une classe donnée."""
    classe_id = int(request.args["classe_id"])
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT d.id, d.date, d.type,
               d.nb_mots_simple, d.nb_mots_g1, d.nb_mots_g2, d.nb_mots_g3,
               d.verrouille,
               cn.niveau
        FROM dictees d
        JOIN classes_niveaux cn ON cn.id = d.niveau_id
        WHERE cn.classe_id = %s
        ORDER BY d.date ASC, d.id ASC
    """, (classe_id,))
    rows = cur.fetchall()

    dictees = []
    for r in rows:
        dt = r["date"]
        if isinstance(dt, datetime):
            date_for_input = dt.strftime("%Y-%m-%dT%H:%M")
            date_display = dt.strftime("%Y-%m-%d %H:%M:%S")
        elif isinstance(dt, date):
            date_for_input = dt.strftime("%Y-%m-%d")
            date_display = dt.strftime("%Y-%m-%d 00:00:00")
        else:
            date_for_input = str(dt)[:16].replace(" ", "T")
            date_display = str(dt)

        dictees.append({
            "id": r["id"],
            "niveau": r["niveau"],
            "type": r["type"],
            "nb_mots_simple": r["nb_mots_simple"],
            "nb_mots_g1": r["nb_mots_g1"],
            "nb_mots_g2": r["nb_mots_g2"],
            "nb_mots_g3": r["nb_mots_g3"],
            "verrouille": r["verrouille"],
            "date": date_display,
            "date_dt": date_for_input,
        })

    ids = [d["id"] for d in dictees]
    resultats_map = {}
    if ids:
        cur.execute("""
            SELECT dictee_id, eleve_id, groupe, erreurs, nb_mots
            FROM dictee_resultats
            WHERE dictee_id = ANY(%s)
        """, (ids,))
        for r in cur.fetchall():
            resultats_map.setdefault(r["dictee_id"], {})[r["eleve_id"]] = r

    cur.close(); conn.close()
    return jsonify(ok=True, dictees=dictees, resultats=resultats_map)

# ---------- Création de classe ----------
@bp.route("/ajouter_classe", methods=["POST"])
def ajouter_classe():
    """Crée une classe + ses niveaux, puis redirige DIRECTEMENT vers la page de la classe."""
    niveaux = request.form.getlist("niveau")
    annee_debut = request.form.get("annee_debut")

    if not niveaux or not annee_debut:
        flash("Merci de remplir tous les champs.", "warning")
        return redirect(request.referrer or url_for("main.index"))

    annee = f"{annee_debut}-{int(annee_debut) + 1}"

    conn = None
    try:
        conn = get_db_connection()
        cur = conn.cursor()

        # Classe même année déjà existante ?
        cur.execute("SELECT id FROM classes WHERE annee = %s", (annee,))
        classe_existante = cur.fetchone()

        if classe_existante:
            classe_id = classe_existante[0]
            # Niveaux déjà tous présents ?
            cur.execute("""
                SELECT niveau
                FROM classes_niveaux
                WHERE classe_id = %s
                ORDER BY """ + NIVEAU_ORDER_COL('niveau'),
                (classe_id,)
            )
            niveaux_existants = [row[0] for row in cur.fetchall()]

            # Si déjà identique → message + go direct dans la classe
            if set(niveaux_existants) == set(niveaux):
                flash(f"La classe {', '.join(niveaux)} {annee} existe déjà.", "info")
                conn.commit()
                cur.close(); conn.close()
                return redirect(url_for("main.page_classe", classe_id=classe_id))

            # Sinon, on complète les niveaux manquants puis on redirige
            manquants = [n for n in niveaux if n not in niveaux_existants]
            for n in manquants:
                cur.execute("INSERT INTO classes_niveaux (classe_id, niveau) VALUES (%s, %s)", (classe_id, n))

            conn.commit()
            flash("Classe mise à jour avec succès.", "success")
            cur.close(); conn.close()
            return redirect(url_for("main.page_classe", classe_id=classe_id))

        # Nouvelle classe
        cur.execute("INSERT INTO classes (annee) VALUES (%s) RETURNING id", (annee,))
        classe_id = cur.fetchone()[0]

        # Niveaux associés
        for niveau in niveaux:
            cur.execute("INSERT INTO classes_niveaux (classe_id, niveau) VALUES (%s, %s)", (classe_id, niveau))

        conn.commit()
        flash("Classe créée avec succès.", "success")
        cur.close(); conn.close()
        # ✅ Arriver directement dans la classe nouvellement créée
        return redirect(url_for("main.page_classe", classe_id=classe_id))

    except Exception as e:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        flash(f"Erreur : {e}", "danger")
        return redirect(request.referrer or url_for("main.index"))

# ---------- Ajout / modif / suppression évaluations ----------
@bp.route("/ajouter_eleve/<int:classe_id>", methods=["POST"])
def ajouter_eleve(classe_id):
    """Ajoute un élève à la classe."""
    nom = request.form["nom"]
    prenom = request.form["prenom"]
    niveau = request.form.get("niveau", "")
    date_naissance = request.form.get("date_naissance", "")

    conn = get_db_connection(); cur = conn.cursor()
    cur.execute("""
        INSERT INTO eleves (nom, prenom, niveau, date_naissance, classe_id)
        VALUES (%s, %s, %s, %s, %s)
    """, (nom, prenom, niveau, date_naissance, classe_id))
    conn.commit()
    cur.close(); conn.close()
    return redirect(url_for("main.page_classe", classe_id=classe_id))

@bp.route("/classe/<int:classe_id>/ajouter_evaluation", methods=["POST"])
def ajouter_evaluation(classe_id):
    """Crée une évaluation + objectifs + niveaux concernés."""
    titre = request.form.get("titre")
    date_str = request.form.get("date")
    matiere_nom = request.form.get("matiere")
    sous_matiere_nom = request.form.get("sous_matiere")
    objectifs = [o.strip() for o in request.form.getlist("objectifs[]") if o.strip()]
    niveaux_concernes = request.form.getlist("niveaux_concernes")

    if not titre or not date_str or not matiere_nom or not objectifs or not niveaux_concernes:
        flash("⚠️ Tous les champs obligatoires doivent être remplis.")
        return redirect(url_for("main.page_classe", classe_id=classe_id, mode="ajout_evaluation"))

    conn = get_db_connection(); cur = conn.cursor()
    try:
        # Matière
        cur.execute("SELECT id FROM matieres WHERE nom = %s", (matiere_nom,))
        matiere = cur.fetchone()
        if matiere:
            matiere_id = matiere[0]
        else:
            cur.execute("INSERT INTO matieres (nom) VALUES (%s)", (matiere_nom,))
            cur.execute("SELECT LASTVAL()")
            matiere_id = cur.fetchone()[0]

        # Sous-matière
        sous_matiere_id = None
        if sous_matiere_nom:
            cur.execute("SELECT id FROM sous_matieres WHERE nom = %s AND matiere_id = %s", (sous_matiere_nom, matiere_id))
            sm = cur.fetchone()
            if sm:
                sous_matiere_id = sm[0]
            else:
                cur.execute("INSERT INTO sous_matieres (nom, matiere_id) VALUES (%s, %s)", (sous_matiere_nom, matiere_id))
                cur.execute("SELECT LASTVAL()")
                sous_matiere_id = cur.fetchone()[0]

        # Évaluation
        cur.execute("""
            INSERT INTO evaluations (titre, date, classe_id, matiere_id, sous_matiere_id)
            VALUES (%s, %s, %s, %s, %s)
        """, (titre, date_str, classe_id, matiere_id, sous_matiere_id))
        cur.execute("SELECT LASTVAL()")
        evaluation_id = cur.fetchone()[0]

        # Objectifs
        for objectif in objectifs:
            cur.execute("INSERT INTO objectifs (evaluation_id, texte) VALUES (%s, %s)", (evaluation_id, objectif))

        # Niveaux
        for niveau in niveaux_concernes:
            cur.execute("INSERT INTO evaluations_niveaux (evaluation_id, niveau) VALUES (%s, %s)", (evaluation_id, niveau))

        conn.commit()
        flash("✅ Évaluation ajoutée avec succès !")

    except Exception as e:
        conn.rollback()
        flash("❌ Erreur : " + str(e))
    finally:
        cur.close(); conn.close()

    return redirect(url_for("main.page_classe", classe_id=classe_id, mode="liste_evaluations"))

@bp.route("/evaluation/<int:evaluation_id>/modifier", methods=["GET", "POST"])
def modifier_evaluation(evaluation_id):
    """Formulaire de modification d’une évaluation (et ses liens)."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Évaluation
    cur.execute("""
        SELECT e.*, m.nom AS matiere_nom, sm.nom AS sous_matiere_nom, c.id AS classe_id, c.annee
        FROM evaluations e
        LEFT JOIN matieres m ON e.matiere_id = m.id
        LEFT JOIN sous_matieres sm ON e.sous_matiere_id = sm.id
        LEFT JOIN classes c ON e.classe_id = c.id
        WHERE e.id = %s
    """, (evaluation_id,))
    evaluation = cur.fetchone()
    if not evaluation:
        cur.close(); conn.close()
        abort(404)

    # Objectifs liés
    cur.execute("SELECT * FROM objectifs WHERE evaluation_id = %s ORDER BY id", (evaluation_id,))
    objectifs = cur.fetchall()

    # Niveaux de la classe (tri canonique)
    cur.execute(
        "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
        (evaluation["classe_id"],)
    )
    niveaux = [row["niveau"] for row in cur.fetchall()]

    # Niveaux concernés
    cur.execute("SELECT niveau FROM evaluations_niveaux WHERE evaluation_id = %s", (evaluation_id,))
    evaluation_niveaux = [row["niveau"] for row in cur.fetchall()]

    # Matières et sous-matières
    cur.execute("SELECT * FROM matieres ORDER BY nom")
    matieres = cur.fetchall()
    cur.execute("SELECT * FROM sous_matieres ORDER BY nom")
    sous_matieres = cur.fetchall()

    # Toutes les classes (menu)
    cur.execute("SELECT * FROM classes ORDER BY annee DESC")
    toutes_les_classes = cur.fetchall()
    for cl in toutes_les_classes:
        cur.execute(
            "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
            (cl["id"],)
        )
        cl["niveaux"] = [row["niveau"] for row in cur.fetchall()]

    # Classe liée (bandeau titre)
    cur.execute("SELECT * FROM classes WHERE id = %s", (evaluation["classe_id"],))
    classe = cur.fetchone()
    cur.execute(
        "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
        (classe["id"],)
    )
    classe["niveaux"] = [row["niveau"] for row in cur.fetchall()]

    if request.method == "POST":
        titre = request.form.get("titre")
        date_str = request.form.get("date")
        matiere_nom = request.form.get("matiere")
        sous_matiere_nom = request.form.get("sous_matiere")
        objectifs_form = [obj.strip() for obj in request.form.getlist("objectifs[]") if obj.strip() != ""]
        niveaux_concernes = request.form.getlist("niveaux_concernes")

        try:
            # Matière
            cur.execute("SELECT id FROM matieres WHERE nom = %s", (matiere_nom,))
            matiere = cur.fetchone()
            if matiere:
                matiere_id = matiere["id"]
            else:
                cur.execute("INSERT INTO matieres (nom) VALUES (%s) RETURNING id", (matiere_nom,))
                matiere_id = cur.fetchone()["id"]

            # Sous-matière
            sous_matiere_id = None
            if sous_matiere_nom:
                cur.execute("SELECT id FROM sous_matieres WHERE nom = %s AND matiere_id = %s", (sous_matiere_nom, matiere_id))
                sm = cur.fetchone()
                if sm:
                    sous_matiere_id = sm["id"]
                else:
                    cur.execute("INSERT INTO sous_matieres (nom, matiere_id) VALUES (%s, %s) RETURNING id", (sous_matiere_nom, matiere_id))
                    sous_matiere_id = cur.fetchone()["id"]

            # Maj évaluation
            cur.execute("""
                UPDATE evaluations
                SET titre = %s, date = %s, matiere_id = %s, sous_matiere_id = %s
                WHERE id = %s
            """, (titre, date_str, matiere_id, sous_matiere_id, evaluation_id))

            # Objectifs
            cur.execute("DELETE FROM objectifs WHERE evaluation_id = %s", (evaluation_id,))
            for obj in objectifs_form:
                cur.execute("INSERT INTO objectifs (evaluation_id, texte) VALUES (%s, %s)", (evaluation_id, obj))

            # Niveaux concernés
            cur.execute("DELETE FROM evaluations_niveaux WHERE evaluation_id = %s", (evaluation_id,))
            for niv in niveaux_concernes:
                cur.execute("INSERT INTO evaluations_niveaux (evaluation_id, niveau) VALUES (%s, %s)", (evaluation_id, niv))

            conn.commit()
            flash("✅ Évaluation modifiée avec succès !")
            return redirect(url_for("main.page_classe", classe_id=evaluation["classe_id"], mode="liste_evaluations"))

        except Exception as e:
            conn.rollback()
            flash(f"❌ Erreur lors de la modification : {e}")

    cur.close(); conn.close()
    return render_template(
        "modifier_evaluation.html",
        evaluation=evaluation,
        objectifs=objectifs,
        niveaux=niveaux,
        matieres=matieres,
        sous_matieres=sous_matieres,
        toutes_les_classes=toutes_les_classes,
        classe=classe,
        evaluation_niveaux=evaluation_niveaux
    )

@bp.route('/evaluation/<int:evaluation_id>/supprimer', methods=['POST'])
def supprimer_evaluation(evaluation_id):
    """Supprime évaluation + dépendances (objectifs, niveaux, résultats)."""
    conn = get_db_connection(); cur = conn.cursor()
    try:
        cur.execute("DELETE FROM resultats WHERE evaluation_id = %s", (evaluation_id,))
        cur.execute("DELETE FROM objectifs WHERE evaluation_id = %s", (evaluation_id,))
        cur.execute("DELETE FROM evaluations_niveaux WHERE evaluation_id = %s", (evaluation_id,))
        cur.execute("DELETE FROM evaluations WHERE id = %s", (evaluation_id,))
        conn.commit()
        flash("Évaluation et résultats supprimés avec succès.")
    except Exception as e:
        conn.rollback()
        flash(f"Erreur lors de la suppression : {e}")
    finally:
        cur.close(); conn.close()

    classe_id = request.form.get('classe_id')
    if classe_id:
        return redirect(url_for('main.page_classe', classe_id=classe_id, mode='liste_evaluations'))
    return redirect(url_for('main.index'))

# ---------- Import CSV élèves ----------
@bp.route("/importer_eleve_csv/<int:classe_id>", methods=["POST"])
def importer_eleve_csv(classe_id):
    """Import CSV élèves (Windows-1252 ; séparateur ';'). Initialise groupe G3."""
    if "csv_file" not in request.files or request.files["csv_file"].filename == "":
        flash("Aucun fichier sélectionné.")
        return redirect(url_for("main.page_classe", classe_id=classe_id))

    try:
        stream = io.StringIO(request.files["csv_file"].stream.read().decode("windows-1252"), newline=None)
        reader = csv.DictReader(stream, delimiter=";")

        conn = get_db_connection(); cur = conn.cursor()

        # mapping CSV -> DB
        mapping = {
            "Nom élève": "nom",
            "Prénom élève": "prenom",
            "Niveau": "niveau",
            "Cycle": "cycle",
            "Regroupement": "regroupement",
            "Classe": "classe",
            "Date inscription": "date_inscription",
            "Nom d'usage": "nom_usage",
            "Deuxième prénom": "deuxieme_prenom",
            "Troisième prénom": "troisieme_prenom",
            "Date naissance": "date_naissance",
            "Commune naissance": "commune_naissance",
            "Dépt naissance": "dept_naissance",
            "Pays naissance": "pays_naissance",
            "Sexe": "sexe",
            "Adresse": "adresse",
            "CP": "cp",
            "Commune": "commune",
            "Pays": "pays",
            "Etat": "etat"
        }

        for row in reader:
            colonnes = []; valeurs = []
            for csv_col, db_col in mapping.items():
                val = (row.get(csv_col) or "").strip()
                colonnes.append(db_col)
                valeurs.append(val if val != "" else None)

            # Ajout classe_id
            colonnes.append("classe_id"); valeurs.append(classe_id)

            sql = f"""
                INSERT INTO eleves ({', '.join(colonnes)})
                VALUES ({', '.join(['%s'] * len(valeurs))})
                RETURNING id
            """
            cur.execute(sql, valeurs)
            eleve_id = cur.fetchone()[0]

            # Groupe G3 par défaut
            cur.execute("""
                INSERT INTO groupes_eleves (eleve_id, groupe, date_changement)
                VALUES (%s, %s, %s)
            """, (eleve_id, 'G3', datetime.now().date()))

        conn.commit()
        flash("✅ Importation réussie.")
    except Exception as e:
        flash(f"❌ Erreur lors de l'import : {e}")
        raise e
    finally:
        try:
            cur.close(); conn.close()
        except Exception:
            pass

    return redirect(url_for("main.page_classe", classe_id=classe_id))

# ---------- Divers ----------
@bp.route("/classe/<int:classe_id>/eleve/<int:eleve_id>/changer_photo", methods=['POST'])
def changer_photo(classe_id, eleve_id):
    """Upload/sauvegarde la photo de l’élève (static/photos)."""
    if 'photo' not in request.files:
        flash("Aucun fichier sélectionné.")
        return redirect(url_for('main.detail_eleve', eleve_id=eleve_id, classe_id=classe_id))

    file = request.files['photo']
    if file.filename == '':
        flash("Aucun fichier sélectionné.")
        return redirect(url_for('main.detail_eleve', eleve_id=eleve_id, classe_id=classe_id))

    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        upload_folder = os.path.join(current_app.root_path, 'static', 'photos')
        os.makedirs(upload_folder, exist_ok=True)
        filepath = os.path.join(upload_folder, filename)
        file.save(filepath)

        conn = get_db_connection(); cur = conn.cursor()
        cur.execute("UPDATE eleves SET photo_filename = %s WHERE id = %s", (filename, eleve_id))
        conn.commit()
        cur.close(); conn.close()

        flash("Photo mise à jour avec succès.")
    else:
        flash("Type de fichier non autorisé. Seules les images sont acceptées.")

    return redirect(url_for('main.detail_eleve', eleve_id=eleve_id, classe_id=classe_id))

@bp.route('/classe/<int:classe_id>/eleve/<int:eleve_id>')
def detail_eleve(classe_id, eleve_id):
    """
    Fiche élève :
      - Bandeau (classe.niveaux + classe.annee)
      - Identité + âge
      - Bulles de notes (toutes matières/sous-matières, même vides)
      - Bloc spécial "Dictées" (toutes, bilans, simples + série temporelle)
      - Moyenne élève + moyenne simple de la classe
    """
    # --- Helpers ---
    SCORE_MAP = {'NA': 0, 'PA': 2, 'A': 4}  # '---'/None ignorés

    DEFAULT_COLOR_BY_MATIERE = {
        'Français': '#87cefa', 'Mathématiques': '#f4a460', 'QLM': '#98fb98',
        'Anglais': '#ff4500', 'EMC': '#a9a9a9', 'EPS': '#ffff00',
        'Musique': '#7b68ee', 'Arts plastiques': '#a0522d', 'Autres': '#607D8B'
    }
    DEFAULT_COLOR = '#607D8B'

    def _to_date(d):
        from datetime import datetime as _dt, date as _date
        if isinstance(d, _date): return d
        if isinstance(d, _dt):   return d.date()
        if isinstance(d, str):
            for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S"):
                try: return _dt.strptime(d, fmt).date()
                except ValueError: pass
        return None

    def _moyenne(vals):
        return round(sum(vals)/len(vals), 1) if vals else None

    def _niveau_depuis_note20(note20):
        if note20 is None: return None
        if note20 >= 20: return "D"
        if 16 < note20 < 20: return "A+"
        if 13 < note20 <= 16: return "A"
        if 12 <= note20 <= 13: return "PA+"
        if 8 <= note20 < 12: return "PA"
        if 6 <= note20 < 8: return "PA-"
        return "NA"

    # --- DB ---
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # 1) Élève (et appartenance à la classe)
    cur.execute("SELECT * FROM eleves WHERE id=%s AND classe_id=%s", (eleve_id, classe_id))
    eleve = cur.fetchone()
    if not eleve:
        cur.close(); conn.close()
        abort(404)

    # 2) Âge
    age = None
    bd = _to_date(eleve.get('date_naissance'))
    if bd:
        today = date.today()
        age = today.year - bd.year - ((today.month, today.day) < (bd.month, bd.day))

    # 3) Classe + niveaux triés (bandeau)
    cur.execute("SELECT * FROM classes WHERE id = %s", (classe_id,))
    classe = cur.fetchone() or abort(404)
    cur.execute(
        "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
        (classe_id,)
    )
    classe["niveaux"] = [r["niveau"] for r in cur.fetchall()]

    # 4) Sidebar — toutes les classes + niveaux
    cur.execute("SELECT * FROM classes ORDER BY annee DESC")
    toutes_les_classes = cur.fetchall()
    for cl in toutes_les_classes:
        cur.execute(
            "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
            (cl["id"],)
        )
        cl["niveaux"] = [row["niveau"] for row in cur.fetchall()]

    # 5) Matières & sous-matières (TOUJOURS affichées, ordre personnalisé)
    if 'MATIERE_ORDER_COL' in globals():
        order_sql = MATIERE_ORDER_COL('nom')
    else:
        order_sql = (
            "CASE nom "
            "WHEN 'Français' THEN 1 "
            "WHEN 'Mathématiques' THEN 2 "
            "WHEN 'QLM' THEN 3 "
            "WHEN 'Anglais' THEN 4 "
            "WHEN 'EMC' THEN 5 "
            "WHEN 'EPS' THEN 6 "
            "WHEN 'Musique' THEN 7 "
            "WHEN 'Arts plastiques' THEN 8 "
            "WHEN 'Autres' THEN 9 "
            "ELSE 99 END"
        )

    cur.execute(
        "SELECT id, nom, COALESCE(couleur, '') AS couleur "
        "FROM matieres ORDER BY " + order_sql + ", nom"
    )
    mat_rows = cur.fetchall()

    cur.execute("SELECT id, nom, matiere_id FROM sous_matieres ORDER BY nom")
    sm_rows = cur.fetchall()

    sm_by_mat = {}
    for m in mat_rows:
        sm_by_mat[m["id"]] = [sm for sm in sm_rows if sm["matiere_id"] == m["id"]]

    # 6) Résultats de l'élève (NA/PA/A -> points -> /20 par évaluation)
    cur.execute("""
        SELECT
            r.evaluation_id,
            UPPER(COALESCE(r.niveau,'')) AS niveau_obj,
            ev.date   AS ev_date,
            ev.matiere_id,
            ev.sous_matiere_id,
            o.texte   AS objectif_nom
        FROM resultats r
        JOIN evaluations ev ON ev.id = r.evaluation_id
        JOIN objectifs  o   ON o.id  = r.objectif_id
        WHERE r.eleve_id = %s
        ORDER BY ev.date DESC, ev.id DESC, o.id
    """, (eleve_id,))
    rows = cur.fetchall()

    from collections import defaultdict
    eval_points = defaultdict(list)  # evaluation_id -> [0/2/4]
    eval_meta   = {}                 # evaluation_id -> {date, matiere_id, sous_matiere_id}
    obj_by_eval = defaultdict(list)  # evaluation_id -> [(objectif_nom, 'NA'|'PA'|'A')]

    for r in rows:
        nv = r["niveau_obj"]
        if nv in SCORE_MAP:  # ignore '---' et vides
            eval_points[r["evaluation_id"]].append(SCORE_MAP[nv])
            obj_by_eval[r["evaluation_id"]].append((r["objectif_nom"], nv))
        if r["evaluation_id"] not in eval_meta:
            eval_meta[r["evaluation_id"]] = {
                "date": _to_date(r["ev_date"]),
                "matiere_id": r["matiere_id"],
                "sous_matiere_id": r["sous_matiere_id"],
            }

    # Note /20 par évaluation
    eval_note20 = {}  # evaluation_id -> (note20, date, matiere_id, sous_matiere_id)
    for eid, pts in eval_points.items():
        if not pts: continue
        note20 = round((sum(pts)/len(pts))/4*20, 1)
        meta = eval_meta[eid]
        eval_note20[eid] = (note20, meta["date"], meta["matiere_id"], meta["sous_matiere_id"])

    # Agrégat par (matiere_id, sous_matiere_id or 0)
    sms_notes = defaultdict(list)   # key=(mid, smid_or_0) -> [note20]
    sms_latest_eval = {}            # key -> (eval_id, date)
    for eid, (n20, d, mid, smid) in eval_note20.items():
        key = (mid, smid if smid is not None else 0)
        sms_notes[key].append(n20)
        prev = sms_latest_eval.get(key)
        if (prev is None) or (d and (prev[1] is None or d > prev[1])):
            sms_latest_eval[key] = (eid, d)

    # 7) D I C T E E S — moyennes + série (niveau élève dans cette classe)
    cur.execute("""
        SELECT
            d.id, d.date, d.type,
            d.nb_mots_simple, d.nb_mots_g1, d.nb_mots_g2, d.nb_mots_g3,
            dr.erreurs, dr.nb_mots AS nb_mots_res, dr.groupe
        FROM dictees d
        JOIN classes_niveaux cn ON cn.id = d.niveau_id
        LEFT JOIN dictee_resultats dr ON dr.dictee_id = d.id AND dr.eleve_id = %s
        WHERE d.classe_id = %s AND cn.niveau = %s
        ORDER BY d.date ASC, d.id ASC
    """, (eleve_id, classe_id, eleve.get('niveau')))
    dictees_rows = cur.fetchall()

    dictees_points_all = []  # [{date: date, note: float, type: 'simple'|'bilan'}]
    notes_all, notes_bilan, notes_simple = [], [], []

    for r in dictees_rows:
        nb = r.get("nb_mots_res")
        if not nb or nb <= 0:
            if (r.get("type") == "simple"):
                nb = r.get("nb_mots_simple")
            else:
                grp = (r.get("groupe") or "G3").upper()
                nb = (
                    r.get("nb_mots_g1") if grp == "G1" else
                    r.get("nb_mots_g2") if grp == "G2" else
                    r.get("nb_mots_g3")
                )
        err = r.get("erreurs")
        if nb and nb > 0 and err is not None:
            try:
                err_i = int(err)
            except (TypeError, ValueError):
                continue
            note = round((nb - err_i) / nb * 20, 1)
            t = (r.get("type") or "simple").lower()
            dictees_points_all.append({"date": _to_date(r.get("date")), "note": note, "type": t})
            notes_all.append(note)
            (notes_bilan if t == "bilan" else notes_simple).append(note)

    dictees_points_all.sort(key=lambda x: (x["date"] or date.min))

    dictees_avg_all    = _moyenne(notes_all)
    dictees_avg_bilan  = _moyenne(notes_bilan)
    dictees_avg_simple = _moyenne(notes_simple)

    dictees_series = [
        {"date": (p["date"].strftime("%Y-%m-%d") if p["date"] else ""), "note": p["note"]}
    for p in dictees_points_all]
    dictees_stats = {"all": dictees_avg_all, "bilan": dictees_avg_bilan, "simple": dictees_avg_simple}

    # 8) Marquer les matières "pertinentes" pour le niveau (info CSS, pas de filtre)
    cur.execute("""
        SELECT DISTINCT e.matiere_id
        FROM evaluations e
        JOIN evaluations_niveaux en ON en.evaluation_id = e.id
        WHERE e.classe_id = %s AND en.niveau = %s
    """, (classe_id, eleve.get('niveau')))
    matiere_ids_for_level = {row["matiere_id"] for row in cur.fetchall() if row["matiere_id"] is not None}

    # 9) View-model pour le template
    matieres_vm = []
    all_student_notes = []

    for m in mat_rows:
        mid = m["id"]
        color = (m.get("couleur") or "").strip() or DEFAULT_COLOR_BY_MATIERE.get(m["nom"], DEFAULT_COLOR)

        sous_vm = []
        sous_notes_for_mat = []

        # Sous-matières déclarées : toujours affichées
        for sm in sm_by_mat.get(mid, []):
            key = (mid, sm["id"])
            notes = sms_notes.get(key, [])
            note_finale = _moyenne(notes)
            niv_final = _niveau_depuis_note20(note_finale)
            if note_finale is not None:
                sous_notes_for_mat.append(note_finale)
                all_student_notes.append(note_finale)

            obj_list = []
            if key in sms_latest_eval:
                last_eid, _ = sms_latest_eval[key]
                for (obj_nom, nv) in obj_by_eval.get(last_eid, []):
                    obj_list.append({"texte": obj_nom, "niveau": nv})

            sous_vm.append({
                "nom": sm["nom"],
                "niveau": niv_final,
                "note_finale": note_finale,
                "niveau_final": niv_final,
                "objectifs": obj_list
            })

        # Bucket "Général" si pas de sous-matière OU notes sans sous_matiere_id
        key_general = (mid, 0)
        need_general = (not sm_by_mat.get(mid)) or (key_general in sms_notes) or (key_general in sms_latest_eval)
        if need_general:
            notes = sms_notes.get(key_general, [])
            note_finale = _moyenne(notes)
            niv_final = _niveau_depuis_note20(note_finale)
            if note_finale is not None:
                sous_notes_for_mat.append(note_finale)
                all_student_notes.append(note_finale)

            obj_list = []
            if key_general in sms_latest_eval:
                last_eid, _ = sms_latest_eval[key_general]
                for (obj_nom, nv) in obj_by_eval.get(last_eid, []):
                    obj_list.append({"texte": obj_nom, "niveau": nv})

            sous_vm.insert(0, {
                "nom": "Général",
                "niveau": niv_final,
                "note_finale": note_finale,
                "niveau_final": niv_final,
                "objectifs": obj_list
            })

        # 🔹 Sous-matière spéciale "Dictées" sous Français (moyenne = toutes dictées)
        if m["nom"] == "Français":
            niv_final_dictees = _niveau_depuis_note20(dictees_avg_all)
            sous_vm.append({
                "nom": "Dictées",
                "niveau": niv_final_dictees,
                "note_finale": dictees_avg_all,
                "niveau_final": niv_final_dictees,
                "objectifs": [],
                "is_dictees": True
            })
            if dictees_avg_all is not None:
                sous_notes_for_mat.append(dictees_avg_all)
                all_student_notes.append(dictees_avg_all)

        # Moyenne matière (sur les sous-matières ayant une note)
        mat_moy = _moyenne(sous_notes_for_mat)
        mat_niv = _niveau_depuis_note20(mat_moy)

        matieres_vm.append({
            "nom": m["nom"],
            "couleur": color,
            "moyenne": mat_moy,    # None -> "—"
            "niveau": mat_niv,     # None -> "—"
            "sous_matieres": sous_vm,
            "pertinente": (mid in matiere_ids_for_level)
        })

    # 10) Moyenne élève + moyenne classe
    moyenne_generale = _moyenne(all_student_notes)
    niveau_general = _niveau_depuis_note20(moyenne_generale)

    cur.execute("""
        SELECT UPPER(COALESCE(r.niveau,'')) AS nv
        FROM resultats r
        JOIN eleves e ON e.id = r.eleve_id
        WHERE e.classe_id = %s
    """, (classe_id,))
    pts = [SCORE_MAP.get(row["nv"]) for row in cur.fetchall() if SCORE_MAP.get(row["nv"]) is not None]
    moyenne_classe = round((sum(pts)/len(pts)/4)*20, 1) if pts else None

    cur.close(); conn.close()

    # 11) Render
    return render_template(
        "partials/detail_eleve.html",
        eleve=eleve,
        classe=classe,
        toutes_les_classes=toutes_les_classes,
        mode="detail_eleve",
        age=age,
        matieres=matieres_vm,
        moyenne_generale=moyenne_generale,
        niveau_general=niveau_general,
        moyenne_classe=moyenne_classe,
        dictees_series=dictees_series,   # → panneau droit (graph)
        dictees_stats=dictees_stats,     # → panneau droit (3 moyennes)
    )






# ---------- Ajout dictée (préparation) ----------
@bp.route("/classe/<int:classe_id>/ajouter_dictee", methods=["GET", "POST"])
def ajouter_dictee(classe_id):
    """Page d’ajout de dictée (prépare datas côté template)."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Classe
    cur.execute("SELECT * FROM classes WHERE id = %s", (classe_id,))
    classe = cur.fetchone()

    # Niveaux (tri canonique)
    cur.execute(
        "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
        (classe_id,)
    )
    niveaux = [row["niveau"] for row in cur.fetchall()]
    classe["niveaux"] = niveaux

    # Élèves par niveau
    eleves_par_niveau = {}
    ids_eleves = []
    for niveau in niveaux:
        cur.execute("""
            SELECT * FROM eleves
            WHERE classe_id = %s AND niveau = %s
            ORDER BY nom
        """, (classe_id, niveau))
        eleves = cur.fetchall()
        eleves_par_niveau[niveau] = eleves
        ids_eleves.extend([e["id"] for e in eleves])

    # Menu latéral
    cur.execute("SELECT id, annee FROM classes ORDER BY annee DESC")
    classes = cur.fetchall()
    toutes_les_classes = []
    for cl in classes:
        cur.execute(
            "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
            (cl["id"],)
        )
        cl["niveaux"] = [row["niveau"] for row in cur.fetchall()]
        toutes_les_classes.append(cl)

    # Groupes par élève (tous changements datés)
    from collections import defaultdict
    groupes_dict = defaultdict(dict)

    if ids_eleves:
        cur.execute("""
            SELECT eleve_id, groupe, date_changement
            FROM groupes_eleves
            WHERE eleve_id = ANY(%s)
            ORDER BY eleve_id, date_changement
        """, (ids_eleves,))
        changements = cur.fetchall()

        groupes_par_eleve = defaultdict(list)
        for row in changements:
            groupes_par_eleve[row["eleve_id"]].append({
                "date": row["date_changement"],
                "groupe": row["groupe"]
            })

        for eleve_id, changements in groupes_par_eleve.items():
            for ch in changements:
                date_str = ch["date"].strftime("%Y-%m-%d %H:%M:%S")
                groupes_dict[eleve_id][date_str] = ch["groupe"]

    cur.close(); conn.close()

    return render_template(
        "classe.html",
        mode="ajouter_dictee",
        classe=classe,
        toutes_les_classes=toutes_les_classes,
        eleves_par_niveau=eleves_par_niveau,
        groupes_dict=groupes_dict
    )

# ---------- Config export ----------
ALIAS = {"slide": "slide-down", "wipe": "wipe-down", "clip": "clip-circle", "scale": "zoom-in"}

@bp.route("/config/export", methods=["GET", "POST"])
def config_export():
    # Menu latéral (classes)
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM classes ORDER BY annee DESC")
    toutes_les_classes = cur.fetchall()
    for cl in toutes_les_classes:
        cur.execute(
            "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
            (cl["id"],)
        )
        cl["niveaux"] = [row["niveau"] for row in cur.fetchall()]
    cur.close()

    # Chemins (ENV > globals)
    global PRIMARY_ROOT, SECONDARY_ROOT, REUNIONS_DIRNAME, _ACTIVE_ROOT, _LAST_CHECK
    current_primary   = os.getenv("DOCS_ROOT_PRIMARY")   or PRIMARY_ROOT
    current_secondary = os.getenv("DOCS_ROOT_SECONDARY") or SECONDARY_ROOT
    current_reunions  = REUNIONS_DIRNAME

    # UI DB
    ui = get_ui_settings_from_db(conn)
    current_anim_mode     = ui["anim_mode"]
    current_anim_duration = ui["anim_duration"]

    if request.method == "POST":
        # Chemins
        PRIMARY_ROOT     = (request.form.get("primary_root") or current_primary).strip()
        SECONDARY_ROOT   = (request.form.get("secondary_root") or current_secondary).strip()
        REUNIONS_DIRNAME = (request.form.get("reunions_dirname") or current_reunions).strip()
        _ACTIVE_ROOT = None; _LAST_CHECK = 0

        # UI (normalise alias)
        mode = (request.form.get("anim_mode") or current_anim_mode).strip()
        mode = ALIAS.get(mode, mode)
        try:
            duration = int(request.form.get("anim_duration", current_anim_duration))
        except (TypeError, ValueError):
            duration = current_anim_duration

        set_ui_settings_in_db(conn, {"anim_mode": mode, "anim_duration": duration})

        # Réponse autosave (fetch)
        if request.headers.get("X-Requested-With") == "fetch":
            conn.close()
            return jsonify(ok=True, ui={"anim_mode": mode, "anim_duration": duration})

        flash("Paramètres enregistrés.", "success")
        conn.close()
        return redirect(url_for(".config_export"))

    # GET
    classe = toutes_les_classes[0] if toutes_les_classes else None
    conn.close()
    return render_template(
        "partials/config_export.html",
        primary_root=current_primary,
        secondary_root=current_secondary,
        reunions_dirname=current_reunions,
        current_anim_mode=current_anim_mode,
        current_anim_duration=current_anim_duration,
        toutes_les_classes=toutes_les_classes,
        classe=classe
    )

# ---------- Injection UI ----------
@bp.app_context_processor
def inject_ui_settings():
    """Rend 'ui' dispo dans TOUS les templates héritant de base.html."""
    try:
        conn = get_db_connection()
        ui = get_ui_settings_from_db(conn)  # {"anim_mode": "...", "anim_duration": ...}
        return {"ui": ui}
    except Exception as e:
        current_app.logger.warning("inject_ui_settings fallback: %s", e)
        # Valeurs sûres par défaut
        return {"ui": {"anim_mode": "slide-down", "anim_duration": 520}}
    finally:
        try:
            conn.close()
        except Exception:
            pass

# ---------- Test chemins ----------
@bp.get("/api/config/test-paths")
def api_test_paths():
    """Test simple d’existence des chemins configurés."""
    p = request.args.get("primary")   or PRIMARY_ROOT
    s = request.args.get("secondary") or SECONDARY_ROOT
    res = {
        "primary":   {"path": p, "exists": os.path.exists(p)},
        "secondary": {"path": s, "exists": os.path.exists(s)},
    }
    return jsonify(ok=True, **res)

@bp.get("/api/education-path")
def api_education_path():
    """
    Retourne le meilleur chemin vers le dossier 'Éducation Nationale'.
    - Teste d'abord Z:\Education Nationale
    - Sinon \\Serveur\Documents\Education Nationale
    Réponse: { ok: bool, path: str, file_url: str }
    """
    candidates = [
        r"Z:\Education Nationale",
        r"\\Serveur\Documents\Education Nationale",
    ]
    for p in candidates:
        try:
            # remplace ce bloc dans api_education_path()
            if p.startswith(r"\\"):
                # UNC —> file://Serveur/Documents/...
                file_url = "file://" + p.lstrip("\\").replace("\\", "/")
            else:
                # Lettre —> file:///Z:/Education...
                file_url = "file:///" + p.replace("\\", "/")


                return jsonify(ok=True, path=p, file_url=file_url)
        except Exception:
            pass
    return jsonify(ok=False, message="Aucun des chemins n'est accessible."), 404

# ---------- Fichier .reg (protocole classimium-en://) ----------
# app/routes/main.py  -> dans download_en_reg()


# app/routes/main.py
@bp.get("/tools/en-protocol.reg", endpoint="download_en_reg")
def download_en_reg():
    reg = r'''Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\Classes\classimium-en]
@="URL:ClassiMium EN"
"URL Protocol"=""

[HKEY_CURRENT_USER\Software\Classes\classimium-en\shell]
@="open"

[HKEY_CURRENT_USER\Software\Classes\classimium-en\shell\open\command]
@="C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command \"$u=$args[0]; if($u){ $u=$u.Trim('\"'); }; $cb=$null; if($u -match '^classimium-en:(//)?(.+)$'){ $cb=[System.Uri]::UnescapeDataString($matches[2]); }; $p1='Z:\\Education Nationale'; $p2='\\\\Serveur\\Documents\\Education Nationale'; if (Test-Path $p1) { Start-Process explorer.exe $p1 } elseif (Test-Path $p2) { Start-Process explorer.exe $p2 }; if ($cb) { try { Invoke-WebRequest -UseBasicParsing -Uri $cb -Method GET | Out-Null } catch {} }\" \"%1\""
'''
    resp = make_response(reg)
    resp.headers["Content-Type"] = "application/octet-stream"
    resp.headers["Content-Disposition"] = 'attachment; filename="classimium-en.reg"'
    return resp






# --- Détection protocole classimium-en:// ---
from time import time

_PROTO_PINGS = {}           # nonce -> timestamp (mémoire process)
_PROTO_TTL   = 60           # on garde l’info 60s max

@bp.get("/protocol/callback", endpoint="protocol_callback")
def protocol_callback():
    """Appelé par le handler Windows (via le protocole). Marque le nonce comme OK."""
    nonce = (request.args.get("nonce") or "").strip()
    if nonce:
        _PROTO_PINGS[nonce] = time()
    # 204 = pas de contenu, retour rapide
    return ("", 204)

@bp.get("/protocol/check", endpoint="protocol_check")
def protocol_check():
    """La page interroge ici pour savoir si le handler a bien ping."""
    nonce = (request.args.get("nonce") or "").strip()
    now   = time()

    # petit ménage
    for k, ts in list(_PROTO_PINGS.items()):
        if now - ts > _PROTO_TTL:
            _PROTO_PINGS.pop(k, None)

    ts = _PROTO_PINGS.get(nonce)
    if ts and (now - ts) <= _PROTO_TTL:
        return jsonify(status="ok")
    return jsonify(status="pending")


@bp.route("/update_resultat/<int:evaluation_id>", methods=["POST"])
def update_resultat(evaluation_id):
    data = request.get_json()
    eleve_id = data.get("eleve_id")
    objectif_id = data.get("objectif_id")
    valeur = data.get("valeur")

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO resultats (evaluation_id, eleve_id, objectif_id, valeur)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (evaluation_id, eleve_id, objectif_id)
        DO UPDATE SET valeur = EXCLUDED.valeur
    """, (evaluation_id, eleve_id, objectif_id, valeur))
    conn.commit()
    cur.close()
    conn.close()

    return jsonify(success=True)


@bp.route("/update_absence/<int:evaluation_id>", methods=["POST"])
def update_absence(evaluation_id):
    data = request.get_json()
    eleve_id = data.get("eleve_id")
    est_absent = data.get("absent")

    conn = get_db_connection()
    cur = conn.cursor()

    if est_absent:
        cur.execute("""
            INSERT INTO absences (evaluation_id, eleve_id)
            VALUES (%s, %s)
            ON CONFLICT DO NOTHING
        """, (evaluation_id, eleve_id))
    else:
        cur.execute("""
            DELETE FROM absences WHERE evaluation_id=%s AND eleve_id=%s
        """, (evaluation_id, eleve_id))

    conn.commit()
    cur.close()
    conn.close()

    return jsonify(success=True)




@bp.route(
    "/classes/<int:classe_id>/evaluations/<int:evaluation_id>/saisir-resultats/<string:niveau>",
    methods=["GET", "POST"],
    endpoint="saisir_resultats"
)
def saisir_resultats(classe_id: int, evaluation_id: int, niveau: str):
    import psycopg2.extras
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    if request.method == "POST":
        form = request.form
        VALID = {"NA", "PA", "A"}

        # 1) Notes : upsert seulement les champs présents et valides
        for key, val in form.items():
            if not key.startswith("resultat_"):
                continue
            try:
                _, eleve_id_str, objectif_id_str = key.split("_", 2)
                eleve_id = int(eleve_id_str)
                objectif_id = int(objectif_id_str)
            except Exception:
                continue

            v = (val or "").strip().upper()
            if v in VALID:
                # delete ciblé puis insert (simple et robuste)
                cur.execute("""
                    DELETE FROM resultats
                    WHERE evaluation_id=%s AND eleve_id=%s AND objectif_id=%s
                """, (evaluation_id, eleve_id, objectif_id))
                cur.execute("""
                    INSERT INTO resultats (evaluation_id, eleve_id, objectif_id, niveau)
                    VALUES (%s,%s,%s,%s)
                """, (evaluation_id, eleve_id, objectif_id, v))
            # si vide -> on ne touche pas la valeur existante

        # 2) Absences : cases cochées reçues, décochées à retirer
        eleves_ids = [int(x) for x in form.getlist("eleve[]")]
        absents_checked = {int(el) for el in eleves_ids if form.get(f"absent_{el}") is not None}

        if eleves_ids:
            # Supprimer pour ceux visibles mais non cochés
            cur.execute("""
                DELETE FROM absences
                WHERE evaluation_id = %s
                  AND eleve_id = ANY(%s)
                  AND NOT (eleve_id = ANY(%s))
            """, (evaluation_id, eleves_ids, list(absents_checked) if absents_checked else [0]))
            # Upsert pour les cochés
            for el in absents_checked:
                cur.execute("""
                    INSERT INTO absences (evaluation_id, eleve_id)
                    VALUES (%s,%s)
                    ON CONFLICT (evaluation_id, eleve_id) DO NOTHING
                """, (evaluation_id, el))

        conn.commit()
        cur.close(); conn.close()
        return ("", 204)

    # -------- GET (F5) : reconstitution complète de l'écran --------

    # Classe + niveaux (titre / sidebar)
    cur.execute("SELECT * FROM classes WHERE id = %s", (classe_id,))
    classe = cur.fetchone() or abort(404, description="Classe introuvable")
    cur.execute(
        "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
        (classe_id,)
    )
    classe["niveaux"] = [r["niveau"] for r in cur.fetchall()]

    cur.execute("SELECT * FROM classes ORDER BY annee DESC")
    toutes_les_classes = cur.fetchall()
    for cl in toutes_les_classes:
        cur.execute(
            "SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY " + NIVEAU_ORDER_COL('niveau'),
            (cl["id"],)
        )
        cl["niveaux"] = [row["niveau"] for row in cur.fetchall()]

    # Évaluation
    cur.execute("SELECT * FROM evaluations WHERE id = %s", (evaluation_id,))
    evaluation = cur.fetchone() or abort(404, description="Évaluation introuvable")

    # Niveaux concernés (tri canonique)
    cur.execute("""
        SELECT niveau
        FROM evaluations_niveaux
        WHERE evaluation_id = %s
        ORDER BY """ + NIVEAU_ORDER_COL('niveau'), (evaluation_id,))
    niveaux_concernes = [row["niveau"] for row in cur.fetchall()]

    # Objectifs — ✅ colonne correcte: texte
    cur.execute("""
        SELECT id, texte
        FROM objectifs
        WHERE evaluation_id = %s
        ORDER BY id
    """, (evaluation_id,))
    objectifs = cur.fetchall()

    # Élèves du niveau demandé — tri par PRÉNOM puis NOM
    cur.execute("""
        SELECT id, nom, prenom, niveau
        FROM eleves
        WHERE classe_id = %s AND niveau = %s
        ORDER BY prenom ASC, nom ASC
    """, (classe_id, niveau))
    eleves = cur.fetchall()

    # Résultats saisis
    cur.execute("""
        SELECT eleve_id, objectif_id, niveau
        FROM resultats
        WHERE evaluation_id = %s
    """, (evaluation_id,))
    rows = cur.fetchall()
    resultats = {e["id"]: {} for e in eleves}
    for r in rows:
        resultats.setdefault(r["eleve_id"], {})[r["objectif_id"]] = r["niveau"]

    # Absences
    cur.execute("SELECT eleve_id FROM absences WHERE evaluation_id = %s", (evaluation_id,))
    absents = {row["eleve_id"] for row in cur.fetchall()}

    cur.close(); conn.close()

    return render_template(
        "classe.html",
        mode="saisie_resultats",
        classe=classe,
        toutes_les_classes=toutes_les_classes,
        evaluation=evaluation,
        niveaux_concernes=niveaux_concernes,
        niveau=niveau,
        objectifs=objectifs,
        eleves=eleves,
        resultats=resultats,
        absents=absents
    )






@bp.post("/api/evaluations/<int:evaluation_id>/resultat")
def api_save_resultat(evaluation_id: int):
    data = request.get_json(silent=True) or {}
    eleve_id = int(data.get("eleve_id"))
    objectif_id = int(data.get("objectif_id"))
    valeur = (data.get("valeur") or "").upper().strip()  # 'NA' | 'PA' | 'A' | '---'

    if valeur not in ("NA", "PA", "A", "---"):
        return jsonify(ok=False, error="valeur invalide"), 400

    conn = get_db_connection(); cur = conn.cursor()
    try:
        # Upsert simple et robuste (delete + insert)
        cur.execute("""
            DELETE FROM resultats
            WHERE evaluation_id=%s AND eleve_id=%s AND objectif_id=%s
        """, (evaluation_id, eleve_id, objectif_id))
        cur.execute("""
            INSERT INTO resultats (evaluation_id, eleve_id, objectif_id, niveau)
            VALUES (%s,%s,%s,%s)
        """, (evaluation_id, eleve_id, objectif_id, valeur))
        conn.commit()
        return jsonify(ok=True)
    except Exception as e:
        conn.rollback()
        return jsonify(ok=False, error=str(e)), 500
    finally:
        try: cur.close(); conn.close()
        except Exception: pass


@bp.post("/api/evaluations/<int:evaluation_id>/absence")
def api_save_absence(evaluation_id: int):
    """
    Marque un élève absent sur TOUTE l'évaluation (tous objectifs -> '---'),
    ou le remet présent (on ne force pas les notes ; on laisse ce qui existe).
    Payload: { eleve_id: int, absent: bool }
    """
    data = request.get_json(silent=True) or {}
    eleve_id = int(data.get("eleve_id"))
    absent = bool(data.get("absent"))

    conn = get_db_connection(); cur = conn.cursor()
    try:
        if absent:
            # Récupère la liste des objectifs pour l'évaluation
            cur.execute("SELECT id FROM objectifs WHERE evaluation_id = %s ORDER BY id", (evaluation_id,))
            obj_ids = [row[0] for row in cur.fetchall()]
            # Met '---' pour tous
            for oid in obj_ids:
                cur.execute("""
                    DELETE FROM resultats
                    WHERE evaluation_id=%s AND eleve_id=%s AND objectif_id=%s
                """, (evaluation_id, eleve_id, oid))
                cur.execute("""
                    INSERT INTO resultats (evaluation_id, eleve_id, objectif_id, niveau)
                    VALUES (%s,%s,%s,'---')
                """, (evaluation_id, eleve_id, oid))
        else:
            # On ne touche pas aux notes existantes ; on enlève juste les '---' si tu veux.
            # Si tu préfères ne rien faire en "présent", commente le bloc suivant.
            cur.execute("""
                UPDATE resultats
                SET niveau = NULL
                WHERE evaluation_id=%s AND eleve_id=%s AND niveau='---'
            """, (evaluation_id, eleve_id))
        conn.commit()
        return jsonify(ok=True)
    except Exception as e:
        conn.rollback()
        return jsonify(ok=False, error=str(e)), 500
    finally:
        try: cur.close(); conn.close()
        except Exception: pass


    


