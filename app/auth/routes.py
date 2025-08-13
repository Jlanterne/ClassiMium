from flask import render_template, request, redirect, url_for, flash
from flask_login import login_user, logout_user, current_user, UserMixin
from werkzeug.security import check_password_hash
from psycopg2.extras import RealDictCursor
from . import auth_bp

# Réutilise le connecteur robuste déjà utilisé (seating)
try:
    from app.seating.routes import db_conn  # fonctionne si présent
except Exception:
    # fallback minimal si on bouge seating: lit config/env
    import os, psycopg2
    from flask import current_app
    def db_conn():
        dsn = (current_app.config.get("SQLALCHEMY_DATABASE_URI")
               or current_app.config.get("DATABASE_URL")
               or os.getenv("SQLALCHEMY_DATABASE_URI")
               or os.getenv("DATABASE_URL"))
        if dsn:
            if dsn.startswith("postgres://"): dsn = dsn.replace("postgres://", "postgresql://", 1)
            return psycopg2.connect(dsn)
        return psycopg2.connect(
            host=current_app.config.get("PGHOST", "localhost"),
            dbname=current_app.config.get("PGDATABASE", "postgres"),
            user=current_app.config.get("PGUSER", "postgres"),
            password=current_app.config.get("PGPASSWORD", ""),
            port=current_app.config.get("PGPORT", "5432")
        )

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
        flash("Identifiants requis", "error"); return redirect(url_for("auth.login_form"))

    conn = db_conn(); cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        cur.execute("SELECT id, username, password_hash, role FROM users WHERE username=%s", (username,))
        row = cur.fetchone()
    finally:
        cur.close(); conn.close()

    if not row or not check_password_hash(row["password_hash"], password):
        flash("Identifiants invalides", "error"); return redirect(url_for("auth.login_form"))

    u = U(); u.id = str(row["id"]); u.username = row["username"]; u.role = row.get("role")
    login_user(u, remember=True)
    return redirect(request.args.get("next") or "/")

@auth_bp.get("/logout")
def logout():
    logout_user()
    return redirect(url_for("auth.login_form"))
