# app/users/routes.py — imports propres
from flask import Blueprint, render_template, request, redirect, url_for, flash, session, current_app
import os, glob
import psycopg2, psycopg2.extras
from werkzeug.security import generate_password_hash
from werkzeug.utils import secure_filename



# Si tu utilises flask_login :
try:
    from flask_login import login_required, current_user
    USE_LOGIN = True
except Exception:
    # fallback si pas de flask_login
    login_required = lambda f: f
    class Dummy:
        id = 1  # à remplacer si pas de login; on mettra un id manuel
    current_user = Dummy()
    USE_LOGIN = False

bp = Blueprint("users", __name__, url_prefix="/user")

def get_dsn():
    # Utilise l’ENV comme le reste de l’app
    return os.environ.get("SQLALCHEMY_DATABASE_URI") or os.environ.get("DATABASE_URL")

@bp.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    """
    GET  : affiche le formulaire pré-rempli avec les infos de l’utilisateur courant
    POST : met à jour les champs + (optionnel) upload(photo) ou suppression(photo)
    """
    import time

    dsn = get_dsn()
    user_id = getattr(current_user, "id", None) or 1  # fallback si pas de login

    # 1) Lire l'utilisateur
    with psycopg2.connect(dsn) as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute("""
                SELECT id, username, role, first_name, last_name, birth_date,
                       photo_path, email, email_academic
                FROM public.users
                WHERE id = %s
            """, (user_id,))
            row = cur.fetchone()
            if not row:
                flash("Utilisateur introuvable.", "error")
                return redirect(url_for("main.index"))

    # URL photo (défaut si vide)
    default_rel = "photos/users/default_user.png"
    rel_path = row["photo_path"] or default_rel
    photo_url = url_for("static", filename=rel_path)

    if request.method == "POST":
        # Champs classiques
        first_name     = request.form.get("first_name") or None
        last_name      = request.form.get("last_name") or None
        birth_date     = request.form.get("birth_date") or None   # YYYY-MM-DD
        email          = request.form.get("email") or None
        email_academic = request.form.get("email_academic") or None
        username       = request.form.get("username") or None
        new_password   = request.form.get("new_password") or ""   # vide = ne pas changer

        # Bouton cliqué ?
        action = (request.form.get("action") or "").strip().lower()
        remove_photo = (action == "remove_photo") or (request.form.get("remove_photo") in ("1","true","on"))

        # Construction dynamique du SET
        set_clauses = [
            "first_name = %s",
            "last_name = %s",
            "birth_date = %s",
            "email = %s",
            "email_academic = %s",
            "username = %s",
        ]
        params = [first_name, last_name, birth_date, email, email_academic, username]

        if new_password.strip():
            set_clauses.append("password_hash = %s")
            params.append(generate_password_hash(new_password.strip()))

        # ---- Photo : soit suppression, soit upload, mais pas les deux ----
        photo_path = None
        upload_dir = current_app.config.get("UPLOAD_USER_PHOTOS_DIR")

        if remove_photo:
            # Supprime les fichiers user_<id>.* et remet la valeur NULL en base
            if upload_dir:
                for old in glob.glob(os.path.join(upload_dir, f"user_{user_id}.*")):
                    try: os.remove(old)
                    except Exception: pass
            set_clauses.append("photo_path = %s")
            params.append(None)  # -> mettra NULL
        else:
            # Upload éventuel
            file = request.files.get("photo")
            if file and file.filename:
                ALLOWED = {"jpg","jpeg","png","webp"}
                filename = secure_filename(file.filename)
                ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
                if ext not in ALLOWED:
                    flash("Format d'image non supporté (jpg, jpeg, png, webp).", "error")
                    return redirect(url_for("users.profile"))

                os.makedirs(upload_dir, exist_ok=True)
                # Supprime les anciennes variantes
                for old in glob.glob(os.path.join(upload_dir, f"user_{user_id}.*")):
                    try: os.remove(old)
                    except Exception: pass

                new_filename = f"user_{user_id}.{ext}"
                abs_path = os.path.join(upload_dir, new_filename)
                file.save(abs_path)

                photo_path = f"photos/users/{new_filename}"
                set_clauses.append("photo_path = %s")
                params.append(photo_path)

        # Exécuter l'UPDATE
        set_sql = ", ".join(set_clauses)
        params.append(user_id)

        try:
            with psycopg2.connect(dsn) as conn:
                with conn.cursor() as cur:
                    cur.execute(f"""
                        UPDATE public.users
                           SET {set_sql}
                         WHERE id = %s
                         RETURNING COALESCE(photo_path, '')
                    """, tuple(params))
                    ret_path = cur.fetchone()[0]
                conn.commit()

            # Met à jour la sidebar (session) selon le cas
            if remove_photo:
                session["user_photo_url"] = url_for("static", filename=default_rel) + f"?v={int(time.time())}"
            elif photo_path:
                session["user_photo_url"] = url_for("static", filename=photo_path) + f"?v={int(time.time())}"
            else:
                # pas de changement : si rien en base, assure un défaut
                if not (ret_path or row["photo_path"]):
                    session["user_photo_url"] = url_for("static", filename=default_rel) + f"?v={int(time.time())}"

            flash("Profil mis à jour.", "success")
            return redirect(url_for("users.profile"))

        except psycopg2.errors.UniqueViolation:
            flash("Adresse e-mail ou identifiant déjà utilisé.", "error")
            return redirect(url_for("users.profile"))
        except Exception as e:
            flash(f"Erreur : {e}", "error")
            return redirect(url_for("users.profile"))

    # GET : afficher la page
    return render_template("user_profile.html", user=row, photo_url=photo_url)



