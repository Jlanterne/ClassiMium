import os
from flask import Flask, redirect, url_for, request
from dotenv import load_dotenv

load_dotenv()  # charge .env AVANT de créer l'app


def create_app():
    app = Flask(
        __name__,
        template_folder="../templates",
        static_folder="../static",
    )

    # --- Config de base ---
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev")

    # 🔕 Auth désactivée globalement (ignore les @login_required & co)
    app.config["LOGIN_DISABLED"] = True

    # (facultatif / legacy)
    app.config["SQLALCHEMY_DATABASE_URI"] = (
        os.environ.get("SQLALCHEMY_DATABASE_URI") or os.environ.get("DATABASE_URL")
    )

    # --- Hooks venant de l'ancien app.py (si présents) ---
    try:
        from app_legacy import load_ui_settings, add_header, inject_ui
        app.before_request(load_ui_settings)
        app.after_request(add_header)
        app.context_processor(inject_ui)
    except Exception as e:
        print("WARN hooks:", e)

    # --- Blueprints ---
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

    # Tu peux laisser le blueprint auth enregistré ou l’enlever.
    # Le laisser ne gêne pas puisque l’auth est désactivée.
    try:
        from .auth import auth_bp
        app.register_blueprint(auth_bp, url_prefix="/auth")
    except Exception as e:
        print("WARN auth:", e)

    # --- Compatibilité url_for pour anciens templates (sans "main.") ---
    from flask import url_for as _url_for
    from werkzeug.routing import BuildError

    def _url_for_compat(endpoint, *args, **kwargs):
        try:
            return _url_for(endpoint, *args, **kwargs)
        except BuildError:
            if "." not in endpoint:
                return _url_for(f"main.{endpoint}", *args, **kwargs)
            raise

    @app.context_processor
    def _inject_url_for_compat():
        return dict(url_for=_url_for_compat)

    # --- (Auth OFF) Neutralise tout mur d'auth global ---
    @app.before_request
    def require_login_everywhere():
        # Auth désactivée : on ne bloque rien.
        return

    # --- Accueil sans authentification ---
    @app.get("/")
    def root():
        # Ajuste la cible si ton accueil est ailleurs
        return redirect("/classes")

    return app
