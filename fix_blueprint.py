# fix_blueprint.py — remet l'app au propre en 1 fois :
# - renomme app.py -> app_legacy.py (si besoin)
# - extrait toutes les routes @app.route/get/post/... dans app/routes/main.py (Blueprint)
# - crée une app factory dans app/__init__.py qui enregistre le blueprint
# - ajoute un /__health
# - crée un run.py minimal
import ast, re, os, pathlib, shutil

ROOT = pathlib.Path.cwd()
PKG  = ROOT / "app"
PKG.mkdir(exist_ok=True)

# 1) Source des routes : app.py ou déjà app_legacy.py
src = ROOT / "app.py"
dst = ROOT / "app_legacy.py"
if src.exists():
    # sauvegarde si un ancien app_legacy.py existe
    if dst.exists():
        shutil.copy2(dst, dst.with_suffix(".py.bak"))
    src.rename(dst)
    print("Renommé: app.py -> app_legacy.py")
else:
    print("app.py introuvable (ok si déjà renommé)")

SRC = dst
if not SRC.exists():
    raise SystemExit("ERREUR: ni app.py ni app_legacy.py trouvés.")

# 2) Extraire toutes les fonctions décorées par @app.route/@app.get/... et convertir en Blueprint
code = SRC.read_text(encoding="utf-8", errors="ignore")
tree = ast.parse(code, filename=str(SRC))

def is_route_decorator(dec):
    return (
        isinstance(dec, ast.Call)
        and isinstance(dec.func, ast.Attribute)
        and isinstance(dec.func.value, ast.Name)
        and dec.func.value.id == "app"
        and dec.func.attr in {"route", "get", "post", "put", "delete", "patch"}
    )

routes = []
for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        if any(is_route_decorator(d) for d in node.decorator_list):
            start = node.lineno - 1
            end   = getattr(node, "end_lineno", node.lineno)
            routes.append((start, end))

PKG_ROUTES = PKG / "routes"
PKG_ROUTES.mkdir(parents=True, exist_ok=True)

# Health route (toujours utile)
health_py = PKG_ROUTES / "health.py"
if not health_py.exists():
    health_py.write_text(
        'from flask import Blueprint\n\nbp = Blueprint("health", __name__)\n\n@bp.route("/__health")\ndef health():\n    return "ok", 200\n',
        encoding="utf-8"
    )

main_py = PKG_ROUTES / "main.py"
if routes:
    lines = code.splitlines()
    blocks = []
    for (start, end) in routes:
        block = "\n".join(lines[start:end])
        block = re.sub(r"@app\.(route|get|post|put|delete|patch)\(", r"@bp.\1(", block)
        block = re.sub(r"\bapp\.config\b", "current_app.config", block)
        blocks.append(block)

    header = (
        "# app/routes/main.py — généré par fix_blueprint.py\n"
        "from flask import Blueprint, render_template, request, redirect, url_for, flash, jsonify, current_app, abort, g\n"
        'bp = Blueprint("main", __name__)\n\n'
        "# On importe tout l'ancien module pour conserver ses helpers (fonctions/constantes)\n"
        "try:\n"
        "    from app_legacy import *  # noqa\n"
        "except Exception:\n"
        "    pass\n\n"
    )
    main_py.write_text(header + "\n\n".join(blocks) + "\n", encoding="utf-8")
    print(f"Créé: {main_py} avec {len(blocks)} route(s)")
else:
    # même si aucune route détectée, on crée un squelette
    if not main_py.exists():
        main_py.write_text(
            "from flask import Blueprint\n\nbp = Blueprint('main', __name__)\n",
            encoding="utf-8"
        )
    print("Aucune @app.route trouvée (ok si tu n’en avais pas).")

# 3) Créer/écraser app/__init__.py (app factory)
init_py = PKG / "__init__.py"
init_py.write_text(
    '''import os
from flask import Flask

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

    return app
''',
    encoding="utf-8"
)
print(f"Écrit: {init_py}")

# 4) run.py minimal
run_py = ROOT / "run.py"
run_py.write_text(
    "from app import create_app\n\napp = create_app()\n\nif __name__ == '__main__':\n    app.run(debug=True)\n",
    encoding="utf-8"
)
print(f"Écrit: {run_py}")

print("\nOK. Lancement suggéré :\n  set FLASK_APP=run.py  (ou $env:FLASK_APP='run.py' sous PowerShell)\n  flask run\n")
