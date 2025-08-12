# app/utils.py — pont propre vers les helpers existants
# (on garde les vraies implémentations dans app_legacy.py pour l’instant)

from app_legacy import (
    # DB
    get_db_connection,

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
