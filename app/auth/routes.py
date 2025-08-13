from flask import render_template, request, redirect, url_for, flash
from flask_login import login_user, logout_user, current_user, UserMixin
from werkzeug.security import check_password_hash
from psycopg2.extras import RealDictCursor
from . import auth_bp

# On réutilise le connecteur déjà présent côté seating
from app.seating.routes import db_conn

class U(UserMixin): pass

@auth_bp.get("/login")
def login_form():
    if current_user.is_authenticated:
        return redirect(request.args.get("next") or "/")
    return render_template("auth/login.html")

@auth_bp.post("/login")
def login_submit():
    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""
    if not username or not password:
        flash("Identifiants requis", "error")
        return redirect(url_for("auth.login_form"))

    conn = db_conn(); cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        cur.execute("SELECT id, username, password_hash, role FROM users WHERE username=%s", (username,))
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()

    if not row or not check_password_hash(row["password_hash"], password):
        flash("Identifiants invalides", "error")
        return redirect(url_for("auth.login_form"))

    u = U(); u.id = str(row["id"]); u.username = row["username"]; u.role = row.get("role")
    login_user(u, remember=True)
    return redirect(request.args.get("next") or "/")

@auth_bp.get("/logout")
def logout():
    logout_user()
    return redirect(url_for("auth.login_form"))
