import sqlite3

conn = sqlite3.connect("base_de_donnees.db")
cur = conn.cursor()

# Table des classes
cur.execute("""
CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    niveaux TEXT
)
""")

# Table des élèves
cur.execute("""
CREATE TABLE IF NOT EXISTS eleves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prenom TEXT,
    nom TEXT,
    sexe TEXT,
    date_naissance TEXT,
    niveau TEXT,
    cycle TEXT,
    regroupement TEXT,
    classe_id INTEGER,
    FOREIGN KEY (classe_id) REFERENCES classes(id)
)
""")

# Table des matières
cur.execute("""
CREATE TABLE IF NOT EXISTS matieres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT UNIQUE NOT NULL
)
""")

# Table des sous-matières
cur.execute("""
CREATE TABLE IF NOT EXISTS sous_matieres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    matiere_id INTEGER,
    FOREIGN KEY (matiere_id) REFERENCES matieres(id)
)
""")

# Table des évaluations
cur.execute("""
CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titre TEXT NOT NULL,
    date TEXT NOT NULL,
    classe_id INTEGER NOT NULL,
    matiere_id INTEGER,
    sous_matiere_id INTEGER,
    FOREIGN KEY (classe_id) REFERENCES classes(id),
    FOREIGN KEY (matiere_id) REFERENCES matieres(id),
    FOREIGN KEY (sous_matiere_id) REFERENCES sous_matieres(id)
)
""")

# Table des objectifs (liés à une évaluation)
cur.execute("""
CREATE TABLE IF NOT EXISTS objectifs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id INTEGER NOT NULL,
    texte TEXT NOT NULL,
    FOREIGN KEY (evaluation_id) REFERENCES evaluations(id)
)
""")

# Table des notes par objectif et par élève
cur.execute("""
CREATE TABLE IF NOT EXISTS eleve_objectifs_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eleve_id INTEGER NOT NULL,
    objectif_id INTEGER NOT NULL,
    niveau TEXT CHECK(niveau IN ('NA', 'PA', 'A')),
    score INTEGER CHECK(score IN (0, 2, 4)),
    FOREIGN KEY (eleve_id) REFERENCES eleves(id),
    FOREIGN KEY (objectif_id) REFERENCES objectifs(id)
)
""")

# Table des résultats
cur.execute("""
CREATE TABLE IF NOT EXISTS resultats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eleve_id INTEGER NOT NULL,
    evaluation_id INTEGER NOT NULL,
    objectif_id INTEGER NOT NULL,
    niveau TEXT CHECK(niveau IN ('NA', 'PA', 'A')) NOT NULL,
    FOREIGN KEY (eleve_id) REFERENCES eleves(id),
    FOREIGN KEY (evaluation_id) REFERENCES evaluations(id),
    FOREIGN KEY (objectif_id) REFERENCES objectifs(id)
)
""")



# Insertion d’une classe de test si aucune n’existe
cur.execute("SELECT COUNT(*) FROM classes")
if cur.fetchone()[0] == 0:
    cur.execute("INSERT INTO classes (nom, niveaux) VALUES (?, ?)", ("Classe CE2 2024-2025", "CE2"))

conn.commit()
conn.close()

print("✅ Base initialisée avec succès.")
