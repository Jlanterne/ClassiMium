import os
from flask import Flask
from dotenv import load_dotenv
load_dotenv()  # charge .env s'il existe, avant de créer l'app


def create_app():
    app = Flask(
        __name__,
        template_folder="../templates",
        static_folder="../static",
    )
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev")

    # Hooks venant de l'ancien app.py (devenu app_legacy.py)
    try:
        from app_legacy import load_ui_settings, add_header, inject_ui
        app.before_request(load_ui_settings)
        app.after_request(add_header)
        app.context_processor(inject_ui)
    except Exception as e:
        print("WARN hooks:", e)

    # Blueprint health
    try:
        from .routes.health import bp as health_bp
        app.register_blueprint(health_bp)
    except Exception as e:
        print("WARN health:", e)

    # Blueprint principal (routes extraites)
    try:
        from .routes.main import bp as main_bp
        app.register_blueprint(main_bp)
    except Exception as e:
        print("WARN main:", e)

    # --- Compatibilité url_for pour anciens templates (sans "main.") ---
    from flask import url_for as _url_for
    from werkzeug.routing import BuildError

    def _url_for_compat(endpoint, *args, **kwargs):
        try:
            return _url_for(endpoint, *args, **kwargs)
        except BuildError:
            # Ancien endpoint sans préfixe -> réessaie avec "main."
            if '.' not in endpoint:
                return _url_for(f"main.{endpoint}", *args, **kwargs)
            raise

    @app.context_processor
    def _inject_url_for_compat():
        # injecte url_for compat dans tous les templates
        return dict(url_for=_url_for_compat)
    
    from app.seating import seating_bp
    if 'seating' not in app.blueprints:           # évite double enregistrement
        app.register_blueprint(seating_bp, url_prefix='/seating')


    return app

from flask_login import LoginManager, current_user, UserMixin
from flask import redirect, url_for, request

login_manager = LoginManager()
login_manager.login_view = "auth.login_form"
login_manager.login_message = None  # pas d'alerte par défaut
login_manager.init_app(app)

# Connexion DB locale (évite import croisé seating)
def _conn():
    import os, psycopg2
    dsn = (app.config.get("SQLALCHEMY_DATABASE_URI")
           or app.config.get("DATABASE_URL")
           or os.getenv("SQLALCHEMY_DATABASE_URI")
           or os.getenv("DATABASE_URL"))
    if dsn:
        if dsn.startswith("postgres://"): dsn = dsn.replace("postgres://", "postgresql://", 1)
        return psycopg2.connect(dsn)
    return psycopg2.connect(
        host=app.config.get("PGHOST", "localhost"),
        dbname=app.config.get("PGDATABASE", "postgres"),
        user=app.config.get("PGUSER", "postgres"),
        password=app.config.get("PGPASSWORD", ""),
        port=app.config.get("PGPORT", "5432")
    )

class User(UserMixin): pass

@login_manager.user_loader
def load_user(user_id: str):
    try:
        conn = _conn(); cur = conn.cursor()
        cur.execute("SELECT id, username, role FROM users WHERE id=%s", (user_id,))
        row = cur.fetchone()
    except Exception:
        row = None
    finally:
        try: cur.close(); conn.close()
        except Exception: pass
    if not row: return None
    u = User(); u.id = str(row[0]); u.username = row[1]; u.role = row[2] if len(row)>2 else None
    return u

# Mur d'auth pour tout le site (sauf static + auth)
EXEMPT = {"auth.login_form", "auth.login_submit", "auth.logout", "static"}
@app.before_request
def require_login_everywhere():
    ep = request.endpoint or ""
    if ep in EXEMPT or ep.startswith("auth."):
        return
    # autorise aussi les assets blueprint static éventuels
    if ep.endswith(".static"):
        return
    if not current_user.is_authenticated:
        return redirect(url_for("auth.login_form", next=request.url))
