from flask import Blueprint, render_template
from app.db import get_db_connection

main_bp = Blueprint('main', __name__)

# --- PAGE D'ACCUEIL : Liste des classes ---
@app.routes("/")
def index():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("SELECT * FROM classes ORDER BY annee DESC")
    classes = cur.fetchall()

    # Pour chaque classe, on ajoute la liste des niveaux associés
    for c in classes:
        cur.execute("SELECT niveau FROM classes_niveaux WHERE classe_id = %s ORDER BY niveau", (c["id"],))
        niveaux = [row["niveau"] for row in cur.fetchall()]
        c["niveaux"] = niveaux

    cur.close()
    conn.close()
    return render_template("index.html", classes=classes)