# app/routes/health.py
from flask import Blueprint

bp = Blueprint("health", __name__)

@bp.route("/__health")
def health():
    return "ok", 200
