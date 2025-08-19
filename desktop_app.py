# desktop_app.py — ouverture immédiate + splash, imports lourds après l'UI
import os, threading, time, socket, platform, subprocess, urllib.request
os.environ["PYWEBVIEW_GUI"] = "edgechromium"  # force Edge WebView2 (plus rapide)

import webview  # léger : OK de l'importer avant

def find_free_port(start=5001, end=5099):
    for p in range(start, end+1):
        try:
            s = socket.socket()
            s.bind(("127.0.0.1", p))
            s.close()
            return p
        except OSError:
            continue
    return 0

class Bridge:
    def open_file_dialog(self):
        return webview.windows[0].create_file_dialog(webview.OPEN_DIALOG) or []
    def save_file_dialog(self, default_name="document.txt"):
        res = webview.windows[0].create_file_dialog(webview.SAVE_DIALOG, save_filename=default_name)
        if not res: return ""
        return res if isinstance(res, str) else res[0]
    def open_with_system(self, path):
        if platform.system() == "Windows":
            subprocess.run(["start", path], shell=True)
        elif platform.system() == "Darwin":
            subprocess.run(["open", path])
        else:
            subprocess.run(["xdg-open", path])
        return True

if __name__ == "__main__":
    # 1) Fenêtre immédiate avec splash (avant TOUT import lourd)
    splash_html = """
    <!doctype html><meta charset="utf-8">
    <title>ClassiMium — chargement…</title>
    <style>
      html,body{height:100%;margin:0;font-family:system-ui;-webkit-font-smoothing:antialiased}
      .wrap{height:100%;display:grid;place-items:center}
      .box{text-align:center}
      .logo{font-size:28px;font-weight:700;color:#2563eb;margin-bottom:8px}
      .sub{color:#666}
    </style>
    <div class="wrap"><div class="box">
      <div class="logo">ClassiMium</div>
      <div class="sub">Démarrage en cours…</div>
    </div></div>
    """
    win = webview.create_window(
        "ClassiMium",
        html=splash_html,
        width=1280, height=800,
        js_api=Bridge()
    )

    # 2) Boot : on importe Flask/DB/APIs APRÈS l'ouverture de la fenêtre
    def boot(app_window):
        from waitress import serve  # import "lourd" ici
        try:
            from run import app  # ta vraie app (app = create_app())
        except Exception as e:
            app_window.load_html(f"<h1>Erreur d’import run.py</h1><pre>{e}</pre>")
            return

        def run_flask(port):
            try:
                serve(app, host="127.0.0.1", port=port, threads=4)
            except Exception as e:
                app_window.load_html(f"<h1>Erreur serveur</h1><pre>{e}</pre>")

        PORT = find_free_port()
        threading.Thread(target=run_flask, args=(PORT,), daemon=True).start()

        # 3) Attendre que Flask réponde puis basculer sur l'URL
        url = f"http://127.0.0.1:{PORT}/"
        for _ in range(60):  # ~30 s max
            try:
                with urllib.request.urlopen(url, timeout=0.6) as r:
                    if r.status == 200:
                        app_window.load_url(url)
                        return
            except Exception:
                pass
            time.sleep(0.5)
        app_window.load_html("<h1>Erreur : le serveur ne démarre pas.</h1>")

    # Log activé en debug build pour voir "Using EdgeChromium"
    webview.start(boot, win, gui="edgechromium", debug=True)
