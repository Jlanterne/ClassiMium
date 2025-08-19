# fix_urlfor_prefix.py — ajoute "main." aux url_for() sans blueprint
# - ignore 'static'
# - gère 'url_for("...")' et 'url_for('...')'
import re, pathlib

TEMPLATES_DIR = pathlib.Path("templates")
EXTS = {".html", ".htm", ".j2", ".jinja", ".jinja2"}

single = re.compile(r"url_for\(\s*'([A-Za-z_]\w*)'\s*([,)])")
double = re.compile(r'url_for\(\s*"([A-Za-z_]\w*)"\s*([,)])')

def repl(m):
    name, tail = m.group(1), m.group(2)
    if name == "static":
        return m.group(0)  # ne touche pas à static
    return f"url_for('main.{name}'{tail})"

def repl_d(m):
    name, tail = m.group(1), m.group(2)
    if name == "static":
        return m.group(0)
    return f'url_for("main.{name}"{tail})'

changed_total = 0
files_total = 0

for p in TEMPLATES_DIR.rglob("*"):
    if p.suffix.lower() not in EXTS or not p.is_file():
        continue
    s = p.read_text(encoding="utf-8", errors="ignore")
    before = s

    # ne modifie que les url_for SANS point (donc sans blueprint)
    # nos regex ne capturent que les noms sans point
    s = single.sub(repl, s)
    s = double.sub(repl_d, s)

    if s != before:
        backup = p.with_suffix(p.suffix + ".bak")
        backup.write_text(before, encoding="utf-8")
        p.write_text(s, encoding="utf-8")
        changed_total += 1
        print(f"[OK] {p} (backup -> {backup.name})")
    files_total += 1

print(f"\nTerminé. Fichiers scannés: {files_total}, fichiers modifiés: {changed_total}")
