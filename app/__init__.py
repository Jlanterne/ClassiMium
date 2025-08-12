# app/__init__.py
import os
from flask import Flask

def create_app():
    app = Flask(
        __name__,
        template_folder="../templates",
        static_folder="../static",
    )
    # Config minimale
    app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev")

    # Blueprint "santé" (ne casse rien de ton code existant)
    try:
        from .routes.health import bp as health_bp
        app.register_blueprint(health_bp)
    except Exception as e:
        print("WARN: registre blueprint health :", e)

    return app
