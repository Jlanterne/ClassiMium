# app/auth.py
import os
from urllib.parse import urlparse, urljoin

from flask import Blueprint, render_template, request, redirect, url_for, session, flash

bp = Blueprint("auth", __name__)

# --- Helpers ---
def _get_creds():
    """
    Identifiants via l'environnement :
      - ADMIN_USER (default: 'admin')
      - ADMIN_PASSWORD (clair) OU ADMIN_PASSWORD_HASH (Werkzeug)
    """
    user = os.environ.get("ADMIN_USER", "admin")
    pw   = os.environ.get("ADMIN_PASSWORD")          # mot de passe en clair (option A)
    pwh  = os.environ.get("ADMIN_PASSWORD_HASH")     # hash Werkzeug (option B)
    return user, pw, pwh

def _is_safe_next(next_url: str) -> bool:
    """Évite les open-redirect: autorise seulement des URLs locales."""
    if not next_url:
        return False
    ref = urlparse(request.host_url)                      # ex: http://127.0.0.1:5000/
    test = urlparse(urljoin(request.host_url, next_url))  # résout les relatives
    return (test.scheme in ("http", "https")) and (test.netloc == ref.netloc)

# --- Routes ---
@bp.route("/login", methods=["GET", "POST"])
def login():
    """
    - GET  : affiche le formulaire
    - POST : vérifie username + password (clair OU hash Werkzeug)
            Si OK -> session['auth'] = True et redirige vers 'next' (si sûr) ou l'index
    Env attendus :
      ADMIN_USER, ADMIN_PASSWORD (ou ADMIN_PASSWORD_HASH)
    """
    from werkzeug.security import check_password_hash

    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        next_url = request.args.get("next") or request.form.get("next")

        env_user, env_pw, env_pwh = _get_creds()
        ok_user = (username == env_user)

        if env_pwh:  # priorité au hash si fourni
            ok_pass = bool(password) and check_password_hash(env_pwh, password)
        else:
            # si ADMIN_PASSWORD est None → refuse (évite login vide par erreur)
            ok_pass = (env_pw is not None) and (password == env_pw)

        if ok_user and ok_pass:
            session.clear()
            session["auth"] = True
            session["username"] = username
            # Quelques infos pour l'UI (facultatives)
            session.setdefault("display_name", username)
            if "USER_ROLE" in os.environ:
                session["role"] = os.environ.get("USER_ROLE")
            if "USER_EMAIL" in os.environ:
                session["email"] = os.environ.get("USER_EMAIL")

            session.permanent = True  # durée définie dans app.config (7j)

            target = next_url if _is_safe_next(next_url) else url_for("main.index")
            return redirect(target)

        flash("Identifiant ou mot de passe incorrect.", "error")

    # GET (ou POST raté) → on renvoie le formulaire
    # On repasse 'next' au template pour le remettre dans l'action ou un input hidden
    return render_template("login.html", next=request.args.get("next"))

@bp.route("/logout")
def logout():
    session.clear()
    flash("Vous êtes déconnecté.", "info")
    return redirect(url_for("auth.login"))
