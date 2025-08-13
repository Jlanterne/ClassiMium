from flask import Blueprint

auth_bp = Blueprint("auth", __name__, template_folder="../../templates/auth")

# IMPORTANT : on importe les routes pour enregistrer les endpoints sur ce blueprint
from . import routes  # noqa: E402,F401
