# app/__init__.py
import os
from datetime import timedelta
from flask import Flask, redirect, url_for, request, session
from dotenv import load_dotenv

from flask_login import LoginManager, UserMixin, current_user
import psycopg2
from psycopg2.extras import RealDictCursor

# essaie d'utiliser l'utilitaire central si présent
try:
    from app.utils import get_db_connection
except Exception:
    get_db_connection = None  # fallback si non dispo

# Charge .env AVANT de créer l'app (DSN, SECRET_KEY, etc.)
load_dotenv()
print("[DB] Using:", os.environ.get("SQLALCHEMY_DATABASE_URI") or os.environ.get("DATABASE_URL"))

# -------- DSN utilitaire --------
def _dsn() -> str:
    return os.environ.get("SQLALCHEMY_DATABASE_URI") or os.environ.get("DATABASE_URL")

# -------- helpers levels + affichage --------
NIVEAU_ORDER = [
    "TPS", "PS", "MS", "GS",
    "CP", "CE1", "CE2", "CM1", "CM2",
    "6E", "5E", "4E", "3E",
    "2NDE", "1ERE", "TERMINALE"
]
_norm = lambda n: (n or "").strip().upper()

def _niveau_key(n):
    n2 = _norm(n)
    try:
        return (0, NIVEAU_ORDER.index(n2))
    except ValueError:
        return (1, n2)  # inconnus après, tri alpha

def _format_niveaux(niveaux):
    if not niveaux:
        return ""
    return " / ".join(sorted(niveaux, key=_niveau_key))

def _format_annee(annee):
    try:
        a = int(annee)
        return f"{a} / {a+1}"
    except Exception:
        return str(annee) if annee is not None else ""

def _env_bool(name: str, default=False):
    v = os.environ.get(name)
    if v is None:
        return default
    return str(v).lower() in ("1", "true", "yes", "on")


# ==============================================
def create_app():
    """
    Application factory.
    - charge la config depuis l'environnement
    - enregistre les blueprints (health, main, seating, auth, users)
    - met en place Flask-Login + garde-barrière simple (session['auth'] OU Flask-Login)
    - injecte la liste des classes (menu) triée + filtres Jinja
    """
    app = Flask(__name__, template_folder="../templates", static_folder="../static")

    # ----- Config sûre (cookies + secret key) -----
    # IMPORTANT : SECRET_KEY DOIT ÊTRE FIXE (pas os.urandom) sinon les cookies sautent.
    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY", "dev-fixed-secret-key"),
        LOGIN_DISABLED=_env_bool("LOGIN_DISABLED", False),

        # Sessions (HTTP en local)
        SESSION_COOKIE_NAME=os.environ.get("SESSION_COOKIE_NAME", "session"),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE=os.environ.get("SESSION_COOKIE_SAMESITE", "Lax"),
        SESSION_COOKIE_SECURE=_env_bool("SESSION_COOKIE_SECURE", False),  # False en local HTTP
        SESSION_COOKIE_DOMAIN=None,   # laisse Flask déduire (localhost/127.0.0.1)
        PERMANENT_SESSION_LIFETIME=timedelta(days=7),

        # Remember (si login_user(..., remember=True))
        REMEMBER_COOKIE_HTTPONLY=True,
        REMEMBER_COOKIE_SAMESITE=os.environ.get("REMEMBER_COOKIE_SAMESITE", "Lax"),
        REMEMBER_COOKIE_SECURE=_env_bool("REMEMBER_COOKIE_SECURE", False),
        REMEMBER_COOKIE_DURATION=timedelta(days=14),
    )

    # Répertoire des photos utilisateur + limite taille (4 Mo)
    app.config["UPLOAD_USER_PHOTOS_DIR"] = os.path.join(app.static_folder, "photos", "users")
    app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024  # 4 Mo
    os.makedirs(app.config["UPLOAD_USER_PHOTOS_DIR"], exist_ok=True)

    # ----- Flask-Login -----
    login_manager = LoginManager()
    login_manager.login_view = "auth.login"
    login_manager.session_protection = "strong"
    login_manager.init_app(app)

    class U(UserMixin):
        pass

    @login_manager.user_loader
    def load_user(user_id: str):
        """Récupère l'utilisateur par son id pour Flask-Login (schéma explicite)."""
        conn = None
        try:
            conn = get_db_connection() if get_db_connection else psycopg2.connect(_dsn())
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id, username, role FROM public.users WHERE id=%s",
                        (int(user_id),),
                    )
                    row = cur.fetchone()
        except Exception as e:
            print("WARN user_loader:", e)
            return None
        finally:
            try:
                conn and conn.close()
            except Exception:
                pass

        if not row:
            return None
        u = U()
        u.id = str(row[0])
        u.username = row[1]
        # u.role = row[2]  # si besoin
        return u

    # ----- Hooks legacy si présents -----
    try:
        from app_legacy import load_ui_settings, add_header, inject_ui
        app.before_request(load_ui_settings)
        app.after_request(add_header)
        app.context_processor(inject_ui)
    except Exception as e:
        print("WARN hooks:", e)

    # ----- Blueprints (imports ICI, pas en top-level) -----
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
        from .auth import auth_bp  # /login et /logout
        app.register_blueprint(auth_bp)
    except Exception as e:
        print("WARN auth:", e)

    try:
        from .users.routes import bp as users_bp
        if "users" not in app.blueprints:
            app.register_blueprint(users_bp, url_prefix="/user")
    except Exception as e:
        print("WARN users:", e)

    # ----- Context processor : liste des classes pour le menu -----
    @app.context_processor
    def inject_sidebar_classes():
        """
        Expose 'toutes_les_classes' pour base.html :
        - chaque item: {id, annee, niveaux (triés)}
        """
        classes = []
        conn = None
        try:
            conn = get_db_connection() if get_db_connection else psycopg2.connect(_dsn())
            with conn:
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("SELECT id, annee FROM public.classes ORDER BY annee DESC;")
                    classes = cur.fetchall() or []

                    for cl in classes:
                        cur.execute(
                            "SELECT niveau FROM public.classes_niveaux WHERE classe_id = %s;",
                            (cl["id"],),
                        )
                        nivs = [r["niveau"] for r in (cur.fetchall() or [])]
                        cl["niveaux"] = sorted(nivs, key=_niveau_key)
        except Exception as e:
            print("WARN inject_sidebar_classes:", e)
            classes = []
        finally:
            try:
                conn and conn.close()
            except Exception:
                pass

        return {"toutes_les_classes": classes}

    # ----- Filtres Jinja -----
    @app.template_filter("format_niveaux")
    def _jinja_format_niveaux(niveaux):
        return _format_niveaux(niveaux)

    @app.template_filter("format_annee")
    def _jinja_format_annee(annee):
        return _format_annee(annee)

    @app.template_filter("format_classe")
    def _jinja_format_classe(cl):
        """
        cl: dict avec clés 'niveaux' et 'annee'
        Retour: 'NV / NV / … - XXXX / XXXX'
        """
        if not cl:
            return ""
        return f"{_format_niveaux(cl.get('niveaux'))} - {_format_annee(cl.get('annee'))}"

    # ----- Garde-barrière : accepte Flask-Login OU session['auth'] -----
    @app.before_request
    def _require_login():
        if app.config.get("LOGIN_DISABLED"):
            return

        # Pages publiques
        open_prefixes = ("/static/",)
        open_exact = {
            
            "/login",
            "/logout",
            "/favicon.ico",
            "/health", "/healthz", "/status",
            "/auth/login", "/auth/logout",

            # Endpoints nécessaires au protocole/button EN et aux tests chemin
            "/protocol/callback",
            "/protocol/check",
            "/tools/en-protocol.reg",
            "/api/education-path",
            "/api/config/test-paths",
        }

        path = (request.path or "/").rstrip("/") or "/"
        if path in open_exact or any(path.startswith(p) for p in open_prefixes):
            return

        # ✅ Autorise si l'un OU l'autre est authentifié
        if session.get("auth") or (hasattr(current_user, "is_authenticated") and current_user.is_authenticated):
            return

        return redirect(url_for("auth.login", next=request.url))

    # ----- Aliases pratiques -----
    @app.get("/auth/login")
    def _alias_login():
        return redirect(url_for("auth.login", next=request.args.get("next")))

    @app.get("/auth/logout")
    def _alias_logout():
        return redirect(url_for("auth.logout"))

    # ----- Accueil -> index -----
    @app.get("/")
    def root():
        if not (session.get("auth") or (hasattr(current_user, "is_authenticated") and current_user.is_authenticated)):
          return redirect(url_for("auth.login", next=request.url))
        return redirect(url_for("main.index"))


    return app
