# app/auth/routes.py
from flask import render_template, request, redirect, url_for, flash, session
from flask_login import login_user, logout_user, current_user, UserMixin
from werkzeug.security import check_password_hash
from psycopg2.extras import RealDictCursor
from . import auth_bp
from app.seating.routes import db_conn

class U(UserMixin): pass

@auth_bp.get("/login", endpoint="login")
def login_form():
    if current_user.is_authenticated:
        # Option: aller vers la classe la plus récente s'il y en a une
        conn = db_conn(); cur = conn.cursor(cursor_factory=RealDictCursor)
        try:
            cur.execute("SELECT id FROM classes ORDER BY annee DESC LIMIT 1")
            row = cur.fetchone()
        finally:
            cur.close(); conn.close()
        if row:
            return redirect(url_for("main.page_classe", classe_id=row["id"]))
        return redirect(url_for("main.index"))
    return render_template("auth/login.html")

@auth_bp.post("/login")
def login_submit():
    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""
    if not username or not password:
        flash("Identifiants requis", "error")
        return redirect(url_for("auth.login"))

    conn = db_conn(); cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        cur.execute("SELECT id, username, password_hash, role FROM users WHERE username=%s", (username,))
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()

    if not row or not check_password_hash(row["password_hash"], password):
        flash("Identifiants invalides", "error")
        return redirect(url_for("auth.login"))

    u = U(); u.id = str(row["id"]); u.username = row["username"]; u.role = row.get("role")
    login_user(u, remember=True)

    # Alimente le layout (sidebar) qui lit session['auth'] / ['username']
    session["auth"] = True
    session["username"] = row["username"]
    session.setdefault("user_photo_url", None)

    # Redirection prioritaire: ?next=..., sinon dernière classe, sinon index
    next_url = request.args.get("next")
    if next_url:
        return redirect(next_url)

    conn = db_conn(); cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        cur.execute("SELECT id FROM classes ORDER BY annee DESC LIMIT 1")
        last = cur.fetchone()
    finally:
        cur.close(); conn.close()

    if last:
        return redirect(url_for("main.page_classe", classe_id=last["id"]))
    return redirect(url_for("main.index"))

@auth_bp.get("/logout")
def logout():
    logout_user()
    for k in ("auth","username","user_photo_url"):
        session.pop(k, None)
    return redirect(url_for("auth.login"))
