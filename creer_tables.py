import psycopg2

def get_db_connection():
    conn = psycopg2.connect(
        host="localhost",
        dbname="gestion_classe",
        user="postgres",         # remplace si besoin
        password="kr6bkhe"
    )
    return conn

def creer_tables():
    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS classes (
            id SERIAL PRIMARY KEY,
            niveau TEXT NOT NULL,
            annee TEXT NOT NULL,
            UNIQUE(niveau, annee)
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS eleves (
            id SERIAL PRIMARY KEY,
            nom TEXT NOT NULL,
            prenom TEXT NOT NULL,
            niveau TEXT,
            date_naissance DATE,
            classe_id INTEGER REFERENCES classes(id) ON DELETE CASCADE
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS matieres (
            id SERIAL PRIMARY KEY,
            nom TEXT NOT NULL UNIQUE
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS sous_matieres (
            id SERIAL PRIMARY KEY,
            nom TEXT NOT NULL,
            matiere_id INTEGER REFERENCES matieres(id) ON DELETE CASCADE,
            UNIQUE(nom, matiere_id)
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS evaluations (
            id SERIAL PRIMARY KEY,
            titre TEXT NOT NULL,
            date DATE NOT NULL,
            classe_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
            matiere_id INTEGER REFERENCES matieres(id) ON DELETE SET NULL,
            sous_matiere_id INTEGER REFERENCES sous_matieres(id) ON DELETE SET NULL
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS objectifs (
            id SERIAL PRIMARY KEY,
            evaluation_id INTEGER REFERENCES evaluations(id) ON DELETE CASCADE,
            texte TEXT NOT NULL
        );
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS resultats (
            id SERIAL PRIMARY KEY,
            eleve_id INTEGER REFERENCES eleves(id) ON DELETE CASCADE,
            objectif_id INTEGER REFERENCES objectifs(id) ON DELETE CASCADE,
            niveau TEXT CHECK(niveau IN ('NA', 'PA', 'A')) NOT NULL,
            UNIQUE(eleve_id, objectif_id)
        );
    """)

    conn.commit()
    cur.close()
    conn.close()
    print("✅ Tables créées avec succès.")

if __name__ == "__main__":
    creer_tables()
