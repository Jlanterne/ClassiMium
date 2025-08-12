# app/utils.py — pont vers app_legacy + DB via .env

import os
from dotenv import load_dotenv
load_dotenv()  # pour que os.getenv lise .env

import psycopg2
import psycopg2.extras

def get_db_connection():
    """Connexion Postgres paramétrable via .env"""
    return psycopg2.connect(
        dbname=os.getenv("DB_NAME", "gestion_classe"),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", ""),
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5432"),
    )

# Le reste vient d'app_legacy (inchangé)
from app_legacy import (
    # Exports / chemins
    pick_docs_root,
    find_year_folder,
    ensure_reunions_dir,
    resolve_export_dir,
    _slug,
    ensure_export_dir_for_rapport,
    export_docx_best_effort,
    export_pdf_faithful,

    # UI settings
    DEFAULT_UI,
    get_ui_settings_from_db,
    set_ui_settings_in_db,
)
