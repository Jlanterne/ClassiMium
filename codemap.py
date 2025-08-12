# codemap.py — génère CODEMAP.md (plan d'archi lisible)
import os, ast, pathlib
from collections import defaultdict

ROOT = pathlib.Path.cwd()
IGNORE_DIRS = {'.git', '__pycache__', '.venv', 'venv', 'node_modules', 'dist', 'build', '.build', '.cache'}

def walk_py(root: pathlib.Path):
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in IGNORE_DIRS and not d.startswith('.')]
        for f in fns:
            if f.endswith('.py'):
                p = pathlib.Path(dp, f)
                yield p.relative_to(root)

def mod_name(rel: pathlib.Path) -> str:
    parts = list(rel.parts)
    if parts[-1] == '__init__.py':
        parts = parts[:-1]
    else:
        parts[-1] = parts[-1][:-3]
    return ".".join(parts)

files = list(walk_py(ROOT))
mods = {mod_name(p): p for p in files}
mod_set = set(mods.keys())

def parent_pkg(m: str) -> str:
    return m.rsplit('.', 1)[0] if '.' in m else ''

def resolve_internal(name: str) -> str | None:
    if name in mod_set:
        return name
    cands = [m for m in mod_set if m == name or m.startswith(name + ".")]
    return min(cands, key=len) if cands else None

# Collecte
imports = defaultdict(set)        # A -> {B, ...}
routes = []                       # (file, func, path, methods)
templates = defaultdict(set)      # file -> {template.html, ...}

for m, rel in sorted(mods.items()):
    path = ROOT / rel
    try:
        src = path.read_text(encoding='utf-8', errors='ignore')
        tree = ast.parse(src, filename=str(rel))
    except Exception:
        continue

    base = parent_pkg(m)

    # imports internes
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                t = resolve_internal(alias.name)
                if t and t != m:
                    imports[m].add(t)
        elif isinstance(node, ast.ImportFrom):
            lvl = getattr(node, "level", 0) or 0
            module = node.module or ''
            pkg = base
            for _ in range(max(lvl - 0, 0)):
                pkg = parent_pkg(pkg)
            full = f"{pkg+'.' if pkg else ''}{module}" if module else pkg
            t = resolve_internal(full) if full else None
            if t and t != m:
                imports[m].add(t)

    # routes Flask (détecte décorateurs *.route(...))
    class RouteFinder(ast.NodeVisitor):
        def visit_FunctionDef(self, fn):
            for dec in fn.decorator_list:
                try:
                    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.func.attr == 'route':
                        # path
                        path_arg = None
                        if dec.args and isinstance(dec.args[0], ast.Constant) and isinstance(dec.args[0].value, str):
                            path_arg = dec.args[0].value
                        # methods
                        methods = None
                        for kw in dec.keywords or []:
                            if kw.arg == 'methods':
                                if isinstance(kw.value, (ast.List, ast.Tuple)):
                                    vals = []
                                    for it in kw.value.elts:
                                        if isinstance(it, ast.Constant) and isinstance(it.value, str):
                                            vals.append(it.value)
                                    methods = ", ".join(vals) if vals else None
                        routes.append((str(rel), fn.name, path_arg or "(?)", methods or "GET"))
                except Exception:
                    pass
            self.generic_visit(fn)

    RouteFinder().visit(tree)

    # templates render_template("xx.html")
    class TemplateFinder(ast.NodeVisitor):
        def visit_Call(self, call):
            try:
                if isinstance(call.func, ast.Name) and call.func.id == 'render_template':
                    if call.args and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str):
                        templates[str(rel)].add(call.args[0].value)
            except Exception:
                pass
            self.generic_visit(call)

    TemplateFinder().visit(tree)

# Écriture du markdown
out = []
out.append("# CODEMAP\n")
out.append("## Modules (.py)\n")
for m, rel in sorted(mods.items()):
    out.append(f"- `{rel}`  ← **{m}**")
out.append("\n## Imports internes (A → B)\n")
if not any(imports.values()):
    out.append("_Aucun import interne détecté._\n")
else:
    for a in sorted(imports.keys()):
        for b in sorted(imports[a]):
            out.append(f"- `{a}` → `{b}`")
out.append("\n## Routes Flask détectées\n")
if not routes:
    out.append("_Aucune route détectée (pas de décorateur `.route`)._\n")
else:
    out.append("| Fichier | Fonction | Path | Méthodes |")
    out.append("|---|---|---|---|")
    for f, fn, p, ms in sorted(routes):
        out.append(f"| `{f}` | `{fn}` | `{p}` | `{ms}` |")
out.append("\n## Templates référencés\n")
if not templates:
    out.append("_Aucun `render_template(...)` détecté._\n")
else:
    for f in sorted(templates.keys()):
        tlist = ", ".join(sorted(templates[f]))
        out.append(f"- `{f}` → {tlist}")

pathlib.Path("CODEMAP.md").write_text("\n".join(out), encoding="utf-8")
print("OK → CODEMAP.md généré")
