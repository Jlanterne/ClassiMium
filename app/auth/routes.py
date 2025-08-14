# app/auth/routes.py
import os
import psycopg2
from psycopg2.extras import RealDictCursor
from flask import render_template, request, redirect, url_for, flash, session
from flask_login import login_user, logout_user, current_user, UserMixin
from werkzeug.security import check_password_hash
from . import auth_bp
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from werkzeug.security import generate_password_hash
from flask import current_app



class U(UserMixin):
    pass


def get_dsn() -> str:
    """Lit le DSN depuis les variables d'env, comme le serveur Flask."""
    return os.environ.get("SQLALCHEMY_DATABASE_URI") or os.environ.get("DATABASE_URL")

def _reset_serializer():
    secret = current_app.config.get("SECRET_KEY", "dev")
    return URLSafeTimedSerializer(secret_key=secret, salt="password-reset")


def fetchone(query: str, params=()):
    """Exécute un SELECT et renvoie une seule ligne (dict) ou None."""
    dsn = get_dsn()
    print("[AUTH] Using DSN:", dsn)
    # Debug léger pour traquer un éventuel mauvais DSN (commentable ensuite)
    # print("[AUTH] Using DSN:", dsn)
    try:
        with psycopg2.connect(dsn) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(query, params)
                return cur.fetchone()
    except Exception as e:
        # Log minimal; on ne 'flash' pas ici car on est hors contexte request
        print("[AUTH] DB error:", e)
        return None


@auth_bp.route("/forgot", methods=["GET", "POST"])
def forgot():
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        if not username:
            flash("Indique un identifiant.", "error")
            return redirect(url_for("auth.forgot"))

        # Récupère l'utilisateur
        try:
            conn = db_conn(); cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute("SELECT id, username FROM public.users WHERE username=%s", (username,))
            row = cur.fetchone()
        finally:
            try: cur.close(); conn.close()
            except Exception: pass

        if not row:
            flash("Utilisateur introuvable.", "error")
            return redirect(url_for("auth.forgot"))

        # Génère un token valable 1h
        s = _reset_serializer()
        token = s.dumps({"uid": row["id"], "u": row["username"]})

        # On affiche directement le lien (pas d'envoi mail ici)
        reset_link = url_for("auth.reset_with_token", token=token, _external=True)
        return render_template("auth/forgot_done.html", reset_link=reset_link, username=row["username"])

    return render_template("auth/forgot.html")


@auth_bp.route("/reset/<token>", methods=["GET", "POST"], endpoint="reset_with_token")
def reset_with_token(token):
    s = _reset_serializer()
    try:
        data = s.loads(token, max_age=3600)  # 1 heure
        user_id = int(data.get("uid"))
    except SignatureExpired:
        flash("Lien expiré. Recommence la procédure.", "error")
        return redirect(url_for("auth.forgot"))
    except BadSignature:
        flash("Lien invalide.", "error")
        return redirect(url_for("auth.forgot"))

    if request.method == "POST":
        new_password = (request.form.get("new_password") or "").strip()
        confirm = (request.form.get("confirm_password") or "").strip()
        if not new_password:
            flash("Entre un nouveau mot de passe.", "error")
            return redirect(url_for("auth.reset_with_token", token=token))
        if new_password != confirm:
            flash("Les mots de passe ne correspondent pas.", "error")
            return redirect(url_for("auth.reset_with_token", token=token))

        phash = generate_password_hash(new_password)
        try:
            conn = db_conn(); cur = conn.cursor()
            cur.execute("UPDATE public.users SET password_hash=%s WHERE id=%s", (phash, user_id))
            conn.commit()
        finally:
            try: cur.close(); conn.close()
            except Exception: pass

        flash("Mot de passe réinitialisé. Tu peux te connecter.", "success")
        return redirect(url_for("auth.login"))

    return render_template("auth/reset_password.html", token=token)


@auth_bp.get("/login", endpoint="login")
def login_form():
    if current_user.is_authenticated:
        row = fetchone("SELECT id FROM public.classes ORDER BY annee DESC LIMIT 1")
        if row:
            return redirect(url_for("main.page_classe", classe_id=row["id"]))
        return redirect(url_for("main.index"))
    return render_template("auth/login.html")


@auth_bp.post("/login")
def login_submit():
    from psycopg2.extras import RealDictCursor
    import psycopg2

    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""
    if not username or not password:
        flash("Identifiants requis", "error")
        return redirect(url_for("auth.login"))

    # DSN identique à celui de l'app
    dsn = get_dsn()
    print("[AUTH] Using DSN:", dsn)

    # Récupère l'utilisateur
    row = None
    try:
        with psycopg2.connect(dsn) as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, username, password_hash, role
                    FROM public.users
                    WHERE username = %s
                """, (username,))
                row = cur.fetchone()
    except Exception as e:
        print("[AUTH] DB error:", e)

    print("[AUTH] username saisi:", username)
    print("[AUTH] row is None ? ->", row is None)

    if not row:
        flash("Identifiants invalides", "error")
        return redirect(url_for("auth.login"))

    ph = row.get("password_hash") or ""
    print("[AUTH] hash prefix ->", (ph.split(":", 1)[0] if ph else "<VIDE>"))
    ok = (check_password_hash(ph, password) if ph else False)
    print("[AUTH] check_password_hash(...) ->", ok)

    if not ok:
        flash("Identifiants invalides", "error")
        return redirect(url_for("auth.login"))

    # Succès : connexion Flask-Login + session
    u = U(); u.id = str(row["id"]); u.username = row["username"]
    login_user(u, remember=True)
    session["auth"] = True
    session["username"] = row["username"]
    session.setdefault("user_photo_url", None)

    # Redirection prioritaire
    next_url = request.args.get("next")
    if next_url:
        return redirect(next_url)

    last = fetchone("SELECT id FROM public.classes ORDER BY annee DESC LIMIT 1")
    if last:
        return redirect(url_for("main.page_classe", classe_id=last["id"]))
    return redirect(url_for("main.index"))



@auth_bp.get("/logout")
def logout():
    logout_user()
    for k in ("auth", "username", "user_photo_url"):
        session.pop(k, None)
    return redirect(url_for("auth.login"))
