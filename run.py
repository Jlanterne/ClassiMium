from app import create_app
app = create_app()

if __name__ == "__main__":
    app.run(debug=True)
    
from app.auth import auth_bp
app.register_blueprint(auth_bp, url_prefix="/auth")

# Première page = login
@app.get("/")
def root():
    return redirect(url_for("auth.login_form"))





