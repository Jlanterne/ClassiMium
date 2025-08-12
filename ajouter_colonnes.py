import sqlite3

conn = sqlite3.connect("base_de_donnees.db")
try:
    conn.execute("ALTER TABLE eleves ADD COLUMN niveau TEXT;")
except:
    print("Colonne 'niveau' déjà présente.")
try:
    conn.execute("ALTER TABLE eleves ADD COLUMN date_naissance TEXT;")
except:
    print("Colonne 'date_naissance' déjà présente.")
conn.commit()
conn.close()

print("✅ Colonnes ajoutées.")
