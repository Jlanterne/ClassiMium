import os
from flask import Blueprint, render_template, request, redirect, url_for, session, flash
from werkzeug.security import check_password_hash

bp = Blueprint("auth", __name__)

def _get_creds():
    """
    Récupère les identifiants depuis l'environnement.
    Si rien n'est défini, on retombe sur admin/admin (à éviter en prod).
    """
    user = os.environ.get("ADMIN_USER", "admin")
    pw   = os.environ.get("ADMIN_PASSWORD")  # mot de passe en clair (option A)
    pwh  = os.environ.get("ADMIN_PASSWORD_HASH")  # hash Werkzeug (option B)
    return user, pw, pwh

@bp.route("/login", methods=["GET", "POST"])
def login():
    """
    - GET : affiche le formulaire
    - POST : vérifie username + password (clair OU hash)
    Si OK -> session["auth"]=True et redirige vers 'next' ou '/'
    """
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        user_env, pw_env, pwh_env = _get_creds()
        ok_user = (username == user_env)

        if pwh_env:  # priorité au hash si présent
            ok_pass = check_password_hash(pwh_env, password)
        else:
            ok_pass = (pw_env is not None and password == pw_env)

        if ok_user and ok_pass:
            session.clear()
            session["auth"] = True
            session["username"] = username
            session.permanent = True
            next_url = request.args.get("next")
            return redirect(next_url or url_for("main.index"))
        else:
            flash("Identifiant ou mot de passe incorrect.", "error")

    return render_template("login.html")

@bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))
