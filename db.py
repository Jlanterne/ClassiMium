import psycopg2
from psycopg2.extras import RealDictCursor

def get_db_connection():
    conn = psycopg2.connect(
        host="localhost",
        database="gestion_classe",
        user="postgres",
        password="kr6bkhe",  # remplace ceci par le tien
        cursor_factory=RealDictCursor
    )
    return conn
