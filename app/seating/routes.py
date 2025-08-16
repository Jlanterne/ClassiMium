from flask import render_template, request, jsonify, abort, current_app, send_file
from psycopg2.extras import RealDictCursor
from io import BytesIO

from . import seating_bp
from .mview import refresh_moyennes_if_needed

# ===== Connexion DB =====
def db_conn():
    import os
    import psycopg2
    from dotenv import load_dotenv, find_dotenv
    try:
        load_dotenv(find_dotenv(), override=False)
    except Exception:
        pass

    dsn = (
        current_app.config.get("SQLALCHEMY_DATABASE_URI")
        or current_app.config.get("DATABASE_URL")
        or os.getenv("SQLALCHEMY_DATABASE_URI")
        or os.getenv("DATABASE_URL")
    )
    if dsn:
        if dsn.startswith("postgres://"):
            dsn = dsn.replace("postgres://", "postgresql://", 1)
        from urllib.parse import urlparse, unquote
        u = urlparse(dsn)
        params = {
            "host": u.hostname or "localhost",
            "port": u.port or 5432,
            "dbname": (u.path[1:] if u.path else None) or os.getenv("PGDATABASE", "postgres"),
        }
        if u.username: params["user"] = unquote(u.username)
        if u.password: params["password"] = unquote(u.password)
        params["options"] = "-c lc_messages=C -c client_encoding=UTF8"
        return psycopg2.connect(**params)

    host = current_app.config.get("PGHOST") or os.getenv("PGHOST", "localhost")
    db   = current_app.config.get("PGDATABASE") or os.getenv("PGDATABASE", "postgres")
    usr  = current_app.config.get("PGUSER") or os.getenv("PGUSER", "postgres")
    pwd  = current_app.config.get("PGPASSWORD") or os.getenv("PGPASSWORD")
    port = current_app.config.get("PGPORT") or os.getenv("PGPORT", "5432")

    params = dict(host=host, dbname=db, user=usr, port=port)
    if pwd:
        params["password"] = pwd
    params["options"] = "-c lc_messages=C -c client_encoding=UTF8"
    import psycopg2
    return psycopg2.connect(**params)

# ===== UI =====
@seating_bp.get("/classe/<int:classe_id>")
def ui_plan_classe(classe_id: int):
    # Important: pas de préfixe 'seating/' ici, le blueprint pointe déjà sur templates/seating
    return render_template("plan_classe.html", classe_id=classe_id)

# ===== API =====
@seating_bp.get("/api/plans/<int:classe_id>")
def api_get_plans(classe_id: int):
    # Rend la MV tolérante (ne fait pas planter la route)
    try:
        refresh_moyennes_if_needed(db_conn)
    except Exception:
        pass

    conn = db_conn(); cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        cur.execute("SELECT * FROM seating_plans WHERE classe_id=%s ORDER BY created_at DESC", (classe_id,))
        plans = cur.fetchall()
        active_plan = next((p for p in plans if p["is_active"]), plans[0] if plans else None)

        seats, furniture, positions = [], [], []
        if active_plan:
            cur.execute("SELECT * FROM seats WHERE plan_id=%s ORDER BY z, id", (active_plan["id"],))
            seats = cur.fetchall()
            cur.execute("SELECT * FROM furniture_items WHERE plan_id=%s ORDER BY z, id", (active_plan["id"],))
            furniture = cur.fetchall()
            cur.execute("SELECT * FROM seating_positions WHERE plan_id=%s", (active_plan["id"],))
            positions = cur.fetchall()

        # Élèves de la classe (+ niveau si dispo)
        classe_niveau = None
        try:
            cur.execute("""
              SELECT e.id, e.prenom, e.nom, e.photo_filename, e.sexe, e.niveau
              FROM eleves e
              WHERE e.classe_id=%s
              ORDER BY e.nom, e.prenom
            """, (classe_id,))
            eleves = cur.fetchall()
        except Exception:
            conn.rollback()
            try:
                cur.execute("SELECT niveau FROM classes WHERE id=%s", (classe_id,))
                r = cur.fetchone()
                if r:
                    classe_niveau = r["niveau"] if isinstance(r, dict) else r[0]
            except Exception:
                conn.rollback()
            cur.execute("""
              SELECT e.id, e.prenom, e.nom, e.photo_filename, e.sexe
              FROM eleves e
              WHERE e.classe_id=%s
              ORDER BY e.nom, e.prenom
            """, (classe_id,))
            eleves = cur.fetchall()

        moyennes_map = {}
        try:
            cur.execute("SELECT eleve_id, moyenne_20 FROM eleve_moyennes")
            for row in cur.fetchall():
                moyennes_map[row["eleve_id"]] = row["moyenne_20"]
        except Exception:
            conn.rollback()

        return jsonify({
            "plans": plans,
            "active_plan": active_plan,
            "seats": seats,
            "furniture": furniture,
            "positions": positions,
            "eleves": [
                {
                    **dict(e),
                    "moyenne_20": moyennes_map.get(e["id"]),
                    "niveau": (dict(e).get("niveau") if "niveau" in dict(e) else classe_niveau)
                }
                for e in eleves
            ]
        })
    finally:
        cur.close(); conn.close()




@seating_bp.post("/api/plans")
def api_create_plan():
    data = request.get_json(force=True)
    classe_id = int(data["classe_id"])
    name      = data.get("name") or "Plan sans nom"
    width     = int(data.get("width", 30))
    height    = int(data.get("height", 20))
    grid_size = int(data.get("grid_size", 32))

    conn = db_conn(); cur = conn.cursor()
    try:
        cur.execute("""
          INSERT INTO seating_plans (classe_id,name,width,height,grid_size,is_active)
          VALUES (%s,%s,%s,%s,%s,FALSE) RETURNING id
        """, (classe_id, name, width, height, grid_size))
        plan_id = cur.fetchone()[0]
        conn.commit()
        return jsonify({"ok": True, "plan_id": plan_id}), 201
    finally:
        cur.close(); conn.close()

@seating_bp.put("/api/plans/<int:plan_id>/activate")
def api_activate_plan(plan_id: int):
    conn = db_conn(); cur = conn.cursor()
    try:
        cur.execute("SELECT classe_id FROM seating_plans WHERE id=%s", (plan_id,))
        r = cur.fetchone()
        if not r: abort(404)
        classe_id = r[0]
        cur.execute("UPDATE seating_plans SET is_active=FALSE WHERE classe_id=%s", (classe_id,))
        cur.execute("UPDATE seating_plans SET is_active=TRUE  WHERE id=%s", (plan_id,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        cur.close(); conn.close()

@seating_bp.post("/api/plans/<int:plan_id>/duplicate")
def api_duplicate_plan(plan_id: int):
    conn = db_conn(); cur = conn.cursor()
    try:
        cur.execute("SELECT classe_id, name, width, height, grid_size FROM seating_plans WHERE id=%s", (plan_id,))
        src = cur.fetchone()
        if not src: abort(404)
        classe_id, name, width, height, grid_size = src
        cur.execute("""
          INSERT INTO seating_plans (classe_id,name,width,height,grid_size,is_active)
          VALUES (%s,%s || ' (copie)',%s,%s,%s,FALSE) RETURNING id
        """, (classe_id, name, width, height, grid_size))
        new_id = cur.fetchone()[0]

        cur.execute("""INSERT INTO seats (plan_id,label,x,y,w,h,rotation,z)
                       SELECT %s, label, x, y, w, h, rotation, z FROM seats WHERE plan_id=%s""", (new_id, plan_id))
        cur.execute("""INSERT INTO furniture_items (plan_id,type,label,x,y,w,h,rotation,z)
                       SELECT %s, type, label, x, y, w, h, rotation, z FROM furniture_items WHERE plan_id=%s""", (new_id, plan_id))
        cur.execute("""INSERT INTO seating_positions (plan_id, eleve_id, x, y, seat_id)
                       SELECT %s, eleve_id, x, y, NULL FROM seating_positions WHERE plan_id=%s""", (new_id, plan_id))
        conn.commit()
        return jsonify({"ok": True, "plan_id": new_id}), 201
    finally:
        cur.close(); conn.close()

@seating_bp.put("/api/plans/<int:plan_id>/positions")
def api_upsert_positions(plan_id: int):
    data = request.get_json(force=True)
    items = data.get("positions", [])
    conn = db_conn(); cur = conn.cursor()
    try:
        for it in items:
            cur.execute("""
              INSERT INTO seating_positions (plan_id, eleve_id, x, y, seat_id)
              VALUES (%s,%s,%s,%s,%s)
              ON CONFLICT (plan_id, eleve_id)
              DO UPDATE SET x=EXCLUDED.x, y=EXCLUDED.y, seat_id=EXCLUDED.seat_id
            """, (plan_id, it["eleve_id"], it["x"], it["y"], it.get("seat_id")))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        cur.close(); conn.close()

@seating_bp.delete("/api/plans/<int:plan_id>/positions")
def api_delete_position(plan_id: int):
    data = request.get_json(force=True)
    eleve_id = int(data["eleve_id"])
    conn = db_conn(); cur = conn.cursor()
    try:
        cur.execute("DELETE FROM seating_positions WHERE plan_id=%s AND eleve_id=%s", (plan_id, eleve_id))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        cur.close(); conn.close()

@seating_bp.put("/api/plans/<int:plan_id>/furniture")
def api_upsert_furniture(plan_id: int):
    data = request.get_json(force=True)
    items = data.get("furniture", [])
    conn = db_conn(); cur = conn.cursor()
    try:
        for it in items:
            fid = it.get("id")
            if fid:
                cur.execute("""
                  UPDATE furniture_items
                     SET type=%s, label=%s, x=%s, y=%s, w=%s, h=%s, rotation=%s, z=%s
                   WHERE id=%s AND plan_id=%s
                """, (it["type"], it.get("label"), it["x"], it["y"], it["w"], it["h"], it.get("rotation",0), it.get("z",0), fid, plan_id))
            else:
                cur.execute("""
                  INSERT INTO furniture_items (plan_id,type,label,x,y,w,h,rotation,z)
                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """, (plan_id, it["type"], it.get("label"), it["x"], it["y"], it["w"], it["h"], it.get("rotation",0), it.get("z",0)))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        cur.close(); conn.close()

@seating_bp.delete("/api/plans/<int:plan_id>/furniture/<int:item_id>")
def api_delete_furniture(plan_id: int, item_id: int):
    conn = db_conn(); cur = conn.cursor()
    try:
        cur.execute("DELETE FROM furniture_items WHERE plan_id=%s AND id=%s", (plan_id, item_id))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        cur.close(); conn.close()

@seating_bp.post("/api/plans/<int:plan_id>/reset")
def api_reset_plan(plan_id: int):
    """
    Soft reset par défaut: supprime seating_positions + furniture_items du plan.
    Si body JSON contient {"full": true}, supprime aussi seats (reset complet).
    """
    data = request.get_json(silent=True) or {}
    full = bool(data.get("full"))

    conn = db_conn(); cur = conn.cursor()
    try:
        # Vérifie que le plan existe
        cur.execute("SELECT 1 FROM seating_plans WHERE id=%s", (plan_id,))
        if not cur.fetchone():
            abort(404)

        # 1) Supprime d'abord les positions (FK vers seats possibles)
        cur.execute("DELETE FROM seating_positions WHERE plan_id=%s", (plan_id,))
        deleted_positions = cur.rowcount or 0

        # 2) Puis les meubles
        cur.execute("DELETE FROM furniture_items WHERE plan_id=%s", (plan_id,))
        deleted_furniture = cur.rowcount or 0

        # 3) Optionnel: reset complet → supprimer aussi seats
        deleted_seats = 0
        if full:
            cur.execute("DELETE FROM seats WHERE plan_id=%s", (plan_id,))
            deleted_seats = cur.rowcount or 0

        conn.commit()
        return jsonify({"ok": True, "full": full, "deleted": {
            "positions": deleted_positions,
            "furniture": deleted_furniture,
            "seats": deleted_seats
        }})
    finally:
        cur.close(); conn.close()

# ===== Export PDF =====
@seating_bp.get("/api/plans/<int:plan_id>/export/pdf")
def api_export_pdf(plan_id: int):
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm

    conn = db_conn(); cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        cur.execute("SELECT * FROM seating_plans WHERE id=%s", (plan_id,))
        plan = cur.fetchone()
        if not plan: abort(404)
        cur.execute("SELECT * FROM furniture_items WHERE plan_id=%s", (plan_id,))
        furn = cur.fetchall()
        cur.execute("""
            SELECT p.*, e.prenom, e.nom
            FROM seating_positions p
            JOIN eleves e ON e.id = p.eleve_id
            WHERE p.plan_id=%s
        """, (plan_id,))
        pos = cur.fetchall()
    finally:
        cur.close(); conn.close()

    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    W,H = A4
    margin = 12*mm
    c.setFont("Helvetica-Bold", 12)
    c.drawString(margin, H-margin, f"Plan de classe — {plan['name']}  ({plan['width']}×{plan['height']} unités)")

    scale = 8
    origin_x = margin
    origin_y = H - margin - (plan["height"]*scale)

    c.setStrokeGray(0.85)
    for gx in range(plan["width"]+1):
        x = origin_x + gx*scale
        c.line(x, origin_y, x, origin_y + plan["height"]*scale)
    for gy in range(plan["height"]+1):
        y = origin_y + gy*scale
        c.line(origin_x, y, origin_x + plan["width"]*scale, y)

    c.setStrokeGray(0.2); c.setFillGray(0.9)
    for f in furn:
        x = origin_x + f["x"]*scale
        y = origin_y + f["y"]*scale
        c.rect(x, y, f["w"]*scale, f["h"]*scale, fill=1)
        if f.get("label"):
            c.setFont("Helvetica", 8)
            c.setFillGray(0.2)
            c.drawString(x+2, y+(f["h"]*scale)/2, f["label"])

    c.setFillGray(0)
    for p in pos:
        x = origin_x + p["x"]*scale
        y = origin_y + p["y"]*scale
        c.circle(x+5, y+5, 4, stroke=1, fill=0)
        c.setFont("Helvetica", 7)
        c.drawString(x+12, y+2, f"{p['nom'].upper()} {p['prenom']}")

    c.showPage(); c.save()
    buf.seek(0)
    return send_file(buf, mimetype="application/pdf",
                     as_attachment=True,
                     download_name=f"plan_classe_{plan_id}.pdf")

# ----- SUPPRESSION D'UN PLAN -----
@seating_bp.route('/api/plans/<int:plan_id>/delete', methods=['POST', 'DELETE'], endpoint='api_delete_plan')
def api_delete_plan(plan_id):
    """
    Supprime le plan et ses dépendances.
    Retourne:
      - 204 si OK
      - 404 si le plan n'existe pas
    """
    db = db_conn()
    cur = db.execute('SELECT id FROM plans WHERE id = %s', (plan_id,))
    row = cur.fetchone()
    if not row:
        return ('', 404)

    # 💾 Adapte les noms de tables si besoin :
    db.execute('DELETE FROM positions  WHERE plan_id = %s', (plan_id,))
    db.execute('DELETE FROM furniture  WHERE plan_id = %s', (plan_id,))
    db.execute('DELETE FROM plans      WHERE id      = %s', (plan_id,))
    db.commit()
    return ('', 204)


# Optionnel : accepter DELETE sur /api/plans/<id>
@seating_bp.route('/api/plans/<int:plan_id>', methods=['DELETE'])
def api_delete_plan_alt(plan_id):
    # redirige vers la même logique
    return api_delete_plan(plan_id)
