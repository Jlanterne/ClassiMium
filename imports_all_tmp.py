import subprocess, sys, pathlib
files = subprocess.check_output(['git','ls-files','*.py']).decode().split()
if not files:
    print('Aucun .py suivi par Git'); raise SystemExit(0)
dot = subprocess.check_output([sys.executable, '-m', 'pyan', *files, '--uses', '--no-defines', '--grouped', '--dot'])
pathlib.Path('imports.dot').write_bytes(dot)
