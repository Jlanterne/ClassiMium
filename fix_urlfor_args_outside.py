# Déplace les arguments remis à tort en dehors de url_for(...)
# Pattern ciblé : url_for('main.xxx',) param=..., foo=bar)
import re, pathlib
TEMPLATES = pathlib.Path("templates")
rx = re.compile(r"url_for\(\s*(['\"])(main\.[A-Za-z_]\w*)\1\s*,\s*\)\s*([^)]+)\)")

changed = 0
for p in TEMPLATES.rglob("*.html"):
    s = p.read_text(encoding="utf-8", errors="ignore")
    new = rx.sub(r"url_for(\1\2\1, \3)", s)
    if new != s:
        p.with_suffix(p.suffix + ".bak2").write_text(s, encoding="utf-8")
        p.write_text(new, encoding="utf-8")
        print(f"Fix: {p}")
        changed += 1
print(f"Modifiés: {changed}")

