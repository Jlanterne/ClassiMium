# desktop_app.py — splash propre (fade-out), fenêtre maximisée ; la page fait le fade-in via base.html
import os, threading, time, socket, platform, subprocess, urllib.request
os.environ["PYWEBVIEW_GUI"] = "edgechromium"  # WebView2

# Durées (ms)
SPLASH_MIN_MS = int(os.environ.get("CLASSIMIUM_SPLASH_MS", "1400"))
FADEOUT_MS    = int(os.environ.get("CLASSIMIUM_FADEOUT_MS", "280"))

import webview


def find_free_port(start=5001, end=5099):
    for p in range(start, end + 1):
        try:
            s = socket.socket(); s.bind(("127.0.0.1", p)); s.close()
            return p
        except OSError:
            pass
    return 0


class Bridge:
    def open_file_dialog(self):
        return webview.windows[0].create_file_dialog(webview.OPEN_DIALOG) or []
    def save_file_dialog(self, default_name="document.txt"):
        res = webview.windows[0].create_file_dialog(webview.SAVE_DIALOG, save_filename=default_name)
        if not res: return ""
        return res if isinstance(res, str) else res[0]
    def open_with_system(self, path):
        try:
            if platform.system() == "Windows":
                subprocess.run(["start", path], shell=True)
            elif platform.system() == "Darwin":
                subprocess.run(["open", path])
            else:
                subprocess.run(["xdg-open", path])
            return True
        except Exception:
            return False


if __name__ == "__main__":
    # Splash HTML simple + fade-out
    splash_html = f"""
    <!doctype html><meta charset="utf-8">
    <title>ClassiMium — chargement…</title>
    <style>
      html,body{{height:100%;margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;-webkit-font-smoothing:antialiased}}
      .wrap{{height:100%;display:grid;place-items:center;background:#0b1220}}
      .box{{text-align:center;padding:16px 24px;border-radius:16px;background:#0f172a;box-shadow:0 10px 30px rgba(0,0,0,.35)}}
      .logo{{font-size:28px;font-weight:800;color:#60a5fa;margin-bottom:8px;letter-spacing:.2px}}
      .sub{{color:#cbd5e1}}
      .pulse{{margin-top:12px;width:64px;height:4px;border-radius:999px;background:#1e293b;overflow:hidden}}
      .pulse::before{{content:"";display:block;height:100%;width:30%;background:#60a5fa;animation:pulse 1.2s infinite ease-in-out}}
      @keyframes pulse{{0%{{margin-left:-30%}}50%{{margin-left:70%}}100%{{margin-left:-30%}}}}
      body.fade-out{{animation:fadeOut {FADEOUT_MS}ms ease-in-out forwards}}
      @keyframes fadeOut{{to{{opacity:0}}}}
    </style>
    <div class="wrap"><div class="box">
      <div class="logo">ClassiMium</div>
      <div class="sub">Démarrage en cours…</div>
      <div class="pulse"></div>
    </div></div>
    <script>
      // permet à Python d'attendre la fin de l'anim
      window._cm_faded = false;
      window._cm_do_fade = function(ms){{
        try{{ document.body.classList.add('fade-out'); setTimeout(function(){{window._cm_faded=true;}}, ms); }}catch(e){{}}
      }};
    </script>
    """

    win = webview.create_window(
        "ClassiMium",
        html=splash_html,
        width=1280, height=800,
        min_size=(1024, 700),
        js_api=Bridge()
    )

    started_at = time.time()

    def boot(app_window):
        # Maximiser (pas fullscreen)
        try:
            app_window.maximize()
        except Exception:
            try:
                if platform.system() == "Windows":
                    import ctypes
                    SPI_GETWORKAREA = 0x0030
                    class RECT(ctypes.Structure):
                        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
                    rect = RECT()
                    ctypes.windll.user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(rect), 0)
                    app_window.move(rect.left, rect.top)
                    app_window.resize(rect.right - rect.left, rect.bottom - rect.top)
            except Exception:
                pass

        # Imports lourds maintenant
        from waitress import serve
        try:
            from run import app  # doit exposer "app"
        except Exception as e:
            app_window.load_html(f"<h1>Erreur d’import <code>run.py</code></h1><pre>{e}</pre>")
            return

        def run_flask(port):
            try:
                serve(app, host="127.0.0.1", port=port, threads=4)
            except Exception as e:
                app_window.load_html(f"<h1>Erreur serveur</h1><pre>{e}</pre>")

        port = find_free_port()
        if not port:
            app_window.load_html("<h1>Erreur : aucun port libre trouvé (5001–5099).</h1>")
            return

        threading.Thread(target=run_flask, args=(port,), daemon=True).start()

        url = f"http://127.0.0.1:{port}/"
        for _ in range(60):
            try:
                with urllib.request.urlopen(url, timeout=0.6) as r:
                    if 200 <= r.status < 400:
                        # Durée minimale du splash
                        elapsed = (time.time() - started_at) * 1000
                        wait_more = max(0, SPLASH_MIN_MS - elapsed)
                        if wait_more: time.sleep(wait_more / 1000)

                        # Fade-out du splash (attendre la fin réelle)
                        try:
                            app_window.evaluate_js(f"_cm_do_fade({FADEOUT_MS});")
                            for _ in range(int(FADEOUT_MS/25)+4):
                                if app_window.evaluate_js("window._cm_faded===true") in (True, 'true'):
                                    break
                                time.sleep(0.025)
                        except Exception:
                            time.sleep(FADEOUT_MS/1000)

                        app_window.load_url(url)
                        return
            except Exception:
                pass
            time.sleep(0.5)

        app_window.load_html("<h1>Erreur : le serveur ne démarre pas.</h1>")

    # pas de DevTools
    os.environ.pop("PYWEBVIEW_DEBUG", None)
    os.environ.pop("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", None)

    webview.start(boot, win, gui="edgechromium", debug=False)
