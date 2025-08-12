# extract_routes.py — v2 robuste
# - source: app_legacy.py si présent, sinon app.py
# - parcours AST complet (ast.walk), capture décorateurs multi-lignes
# - imprime la liste des routes trouvées

import ast, re, pathlib, sys

ROOT = pathlib.Path.cwd()
SRC = ROOT / "app_legacy.py"
if not SRC.exists():
    SRC = ROOT / "app.py"
OUT = ROOT / "app" / "routes" / "main.py"
OUT.parent.mkdir(parents=True, exist_ok=True)

if not SRC.exists():
    sys.exit("ERREUR: ni app_legacy.py ni app.py trouvés.")

code = SRC.read_text(encoding="utf-8", errors="ignore")
tree = ast.parse(code, filename=str(SRC))

def is_route_decorator(dec):
    return (
        isinstance(dec, ast.Call) and
        isinstance(dec.func, ast.Attribute) and
        isinstance(dec.func.value, ast.Name) and
        dec.func.value.id == "app" and
        dec.func.attr in {"route","get","post","put","delete","patch"}
    )

def first_line(node):
    # inclut les décorateurs
    deco_lines = [getattr(d, "lineno", node.lineno) for d in getattr(node, "decorator_list", [])]
    return min(deco_lines+[node.lineno])

def last_line(node):
    return getattr(node, "end_lineno", node.lineno)

routes = []
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        if any(is_route_decorator(d) for d in node.decorator_list):
            start = first_line(node) - 1
            end = last_line(node)
            routes.append((start, end, node))

lines = code.splitlines()
blocks = []
report = []

for (start, end, fn) in routes:
    raw = "\n".join(lines[start:end])
    # @app.xxx( -> @bp.xxx(
    raw = re.sub(r"@app\.(route|get|post|put|delete|patch)\(", r"@bp.\1(", raw)
    # app.config -> current_app.config
    raw = re.sub(r"\bapp\.config\b", "current_app.config", raw)
    blocks.append(raw)

    # petit résumé lisible
    for dec in fn.decorator_list:
        if is_route_decorator(dec):
            method = dec.func.attr.upper()
            path = "?"
            if dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str):
                path = dec.args[0].value
            # methods=["POST",...] à l’intérieur de @app.route(..., methods=[...])
            if method == "ROUTE":
                for kw in getattr(dec, "keywords", []):
                    if kw.arg == "methods" and hasattr(kw.value, "elts"):
                        try:
                            mlist = [e.value for e in kw.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
                            method = ",".join(mlist) or "GET"
                        except Exception:
                            pass
                if method == "ROUTE":
                    method = "GET"
            report.append(f"{method:6s} {path}  -> {fn.name}")

header = '''# app/routes/main.py — généré automatiquement (extract_routes.py v2)
from flask import Blueprint, render_template, request, redirect, url_for, flash, jsonify, current_app, abort, g
bp = Blueprint("main", __name__)

# On importe l'ancien module pour conserver ses utilitaires
try:
    from app_legacy import *  # noqa
except Exception:
    pass

'''

OUT.write_text(header + ("\n\n".join(blocks) + "\n" if blocks else ""), encoding="utf-8")

# Affiche un petit bilan
print(f"Source lue : {SRC.name}")
print(f"Routes trouvées : {len(routes)}")
for line in report:
    print(" -", line)
print(f"Écrit      : {OUT}")
