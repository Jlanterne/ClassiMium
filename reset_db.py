import sqlite3

conn = sqlite3.connect("base_de_donnees.db")
cursor = conn.cursor()

cursor.execute("DROP TABLE IF EXISTS classes")
cursor.execute("DROP TABLE IF EXISTS eleves")

cursor.execute("""
    CREATE TABLE classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        niveau TEXT NOT NULL,
        annee TEXT NOT NULL,
        UNIQUE(niveau, annee)
    )
""")

cursor.execute("""
    CREATE TABLE eleves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nom TEXT,
        prenom TEXT,
        classe_id INTEGER,
        FOREIGN KEY(classe_id) REFERENCES classes(id)
    )
""")

conn.commit()
conn.close()

print("✅ Base de données recréée.")
