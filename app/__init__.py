# app/__init__.py
import os
from datetime import timedelta
from flask import Flask, redirect, url_for, request, session
from dotenv import load_dotenv

from flask_login import LoginManager, UserMixin
from app.seating.routes import db_conn  # OK: pas d'import de app ici

load_dotenv()

def create_app():
    app = Flask(__name__, template_folder="../templates", static_folder="../static")
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev")
    app.config["LOGIN_DISABLED"] = os.environ.get("LOGIN_DISABLED", "false").lower() in ("1","true","yes")
    app.permanent_session_lifetime = timedelta(days=7)
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = os.environ.get("SESSION_COOKIE_SECURE","false").lower() in ("1","true","yes")

    # Flask-Login
    login_manager = LoginManager()
    login_manager.login_view = "auth.login"
    login_manager.init_app(app)

    class U(UserMixin): pass

    @login_manager.user_loader
    def load_user(user_id: str):
        try:
            conn = db_conn(); cur = conn.cursor()
            cur.execute("SELECT id, username, role FROM users WHERE id=%s", (int(user_id),))
            row = cur.fetchone()
        finally:
            try:
                cur.close(); conn.close()
            except Exception:
                pass
        if not row:
            return None
        u = U(); u.id = str(row[0]); u.username = row[1]
        return u

    # Hooks legacy si présents
    try:
        from app_legacy import load_ui_settings, add_header, inject_ui
        app.before_request(load_ui_settings)
        app.after_request(add_header)
        app.context_processor(inject_ui)
    except Exception as e:
        print("WARN hooks:", e)

    # Blueprints (⚠️ imports ICI, pas en top-level)
    try:
        from .routes.health import bp as health_bp
        app.register_blueprint(health_bp)
    except Exception as e:
        print("WARN health:", e)

    try:
        from .routes.main import bp as main_bp
        app.register_blueprint(main_bp)
    except Exception as e:
        print("WARN main:", e)

    try:
        from .seating import seating_bp
        if "seating" not in app.blueprints:
            app.register_blueprint(seating_bp, url_prefix="/seating")
    except Exception as e:
        print("WARN seating:", e)

    try:
        from .auth import auth_bp              # ✅ bon import (depuis app/auth/__init__.py)
        app.register_blueprint(auth_bp)        # expose /login et /logout
    except Exception as e:
        print("WARN auth:", e)

    # Garde-barrière simple basé sur la session (si tu veux garder ce comportement)
    @app.before_request
    def _require_login():
        if app.config.get("LOGIN_DISABLED"):
            return
        open_prefixes = ("/static/",)
        open_exact = {"/login","/logout","/favicon.ico","/health","/healthz","/status","/auth/login","/auth/logout"}
        path = (request.path or "/").rstrip("/") or "/"
        if path in open_exact or any(path.startswith(p) for p in open_prefixes):
            return
        if not session.get("auth"):
            return redirect(url_for("auth.login", next=request.url))

    # Alias pratiques
    @app.get("/auth/login")
    def _alias_login():
        return redirect(url_for("auth.login", next=request.args.get("next")))

    @app.get("/auth/logout")
    def _alias_logout():
        return redirect(url_for("auth.logout"))

    # Accueil → index
    @app.get("/")
    def root():
        return redirect(url_for("main.index"))

    return app
