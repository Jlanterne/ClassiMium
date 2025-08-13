# app/auth/__init__.py
from flask import Blueprint
auth_bp = Blueprint("auth", __name__, template_folder="templates")

# Important: charge les vues pour les rattacher au blueprint
from . import routes  # noqa: F401
