import sqlite3

conn = sqlite3.connect('base_de_donnees.db')
c = conn.cursor()

c.execute("SELECT * FROM objectifs")
for row in c.fetchall():
    print(row)

conn.close()
