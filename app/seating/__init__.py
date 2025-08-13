from flask import Blueprint

seating_bp = Blueprint(
    "seating",
    __name__,
    template_folder="../../templates/seating",
    static_folder="../../static/seating"
)

# Attache les routes
from . import routes  # noqa: E402,F401
