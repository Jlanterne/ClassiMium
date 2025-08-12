# make_import_graph.py — génère imports_mermaid.md (Mermaid) + imports_edges.csv
import os, ast, pathlib, csv

ROOT = pathlib.Path.cwd()
IGNORE_DIRS = {'.git', '__pycache__', '.venv', 'venv', 'node_modules', 'dist', 'build', '.build', '.cache'}

def rel_py_files(root: pathlib.Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS and not d.startswith('.')]
        for f in filenames:
            if f.endswith('.py'):
                yield pathlib.Path(dirpath, f).relative_to(root)

def mod_name(rel_path: pathlib.Path) -> str:
    parts = list(rel_path.parts)
    if parts[-1] == '__init__.py':
        parts = parts[:-1]
    else:
        parts[-1] = parts[-1][:-3]
    return ".".join(parts)

files = list(rel_py_files(ROOT))
mods = {mod_name(p): p for p in files}
mod_set = set(mods.keys())

def parent_pkg(m: str) -> str:
    return m.rsplit('.', 1)[0] if '.' in m else ''

def resolve_internal(name: str) -> str | None:
    if name in mod_set:
        return name
    # ex: "app.routes" → "app.routes.main" ou __init__
    cands = [m for m in mod_set if m == name or m.startswith(name + ".")]
    return min(cands, key=len) if cands else None

edges = set()
for m, rel in mods.items():
    try:
        src = (ROOT / rel).read_text(encoding='utf-8', errors='ignore')
        tree = ast.parse(src, filename=str(rel))
    except Exception:
        continue
    base = parent_pkg(m)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                t = resolve_internal(alias.name)
                if t and t != m:
                    edges.add((m, t))
        elif isinstance(node, ast.ImportFrom):
            lvl = getattr(node, "level", 0) or 0
            module = node.module or ''
            pkg = base
            for _ in range(max(lvl-0, 0)):
                pkg = parent_pkg(pkg)
            full = f"{pkg+'.' if pkg else ''}{module}" if module else pkg
            t = resolve_internal(full) if full else None
            if t and t != m:
                edges.add((m, t))

# --- Mermaid: IDs simples + labels jolis ---
names = sorted({x for e in edges for x in e})
idmap = {name: f"n{idx+1}" for idx, name in enumerate(names)}
def label(s: str) -> str:
    return s.replace('"', '&quot;')

lines = ["```mermaid", "flowchart LR"]
# déclarer les nœuds avec label (ex: n1["app.routes.main"])
for name in names:
    lines.append(f'  {idmap[name]}["{label(name)}"]')
# puis les arêtes
for a, b in sorted(edges):
    lines.append(f'  {idmap[a]} --> {idmap[b]}')
lines.append("```")
pathlib.Path("imports_mermaid.md").write_text("\n".join(lines), encoding="utf-8")

# CSV brut
with open("imports_edges.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["from","to"])
    for a, b in sorted(edges):
        w.writerow([a, b])

print(f"OK: {len(edges)} arêtes")
