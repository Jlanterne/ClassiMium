import psycopg2

def get_db_connection():
    return psycopg2.connect(
        dbname="gestion_classe",
        user="postgres",
        password="kr6bkhe",
        host="localhost",
        port="5432"
    )