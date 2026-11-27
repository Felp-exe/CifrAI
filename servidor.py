"""Servidor local do CifrAI (apenas para desenvolvimento e testes).

Faz o mesmo que `python -m http.server`, mas manda o navegador SEMPRE buscar a versão
mais nova dos arquivos. Sem isso, o navegador pode mostrar uma versão antiga do app
depois que os arquivos mudam.

Uso:  python servidor.py [porta]      (porta padrão: 8080)
"""
import mimetypes
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")


class SemCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"CifrAI em http://localhost:{port}  (Ctrl+C para encerrar)")
    ThreadingHTTPServer(("", port), SemCache).serve_forever()
