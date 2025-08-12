import sqlite3

conn = sqlite3.connect("classe.db")
cur = conn.cursor()

cur.execute("SELECT COUNT(*) FROM config_classe")
print("Nombre de classes :", cur.fetchone()[0])

cur.execute("SELECT COUNT(*) FROM eleves")
print("Nombre d'élèves :", cur.fetchone()[0])

conn.close()
