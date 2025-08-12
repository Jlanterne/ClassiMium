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


    return app
