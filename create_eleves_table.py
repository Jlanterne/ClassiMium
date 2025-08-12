import sqlite3

conn = sqlite3.connect("classe.db")
cursor = conn.cursor()

cursor.execute("""
CREATE TABLE IF NOT EXISTS eleves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    classe_id INTEGER NOT NULL,
    nom TEXT,
    prenom TEXT,
    sexe TEXT,
    date_naissance TEXT,
    niveau TEXT,
    cycle TEXT,
    regroupement TEXT,
    classe_label TEXT,
    FOREIGN KEY (classe_id) REFERENCES config_classe(id)
)
""")

conn.commit()
conn.close()

print("✅ Table 'eleves' créée ou déjà existante.")
