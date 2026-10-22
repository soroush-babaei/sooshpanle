"""سایدکار آمار Xray — خواندن آمار gRPC از `xray api statsquery` و سرو آن روی HTTP.

این کانتینر با network_mode: service:xray اجرا می‌شود تا به
127.0.0.1:10085 (StatsService) دسترسی داشته باشد و خروجی JSON را
روی پورت 9000 به پنل بدهد.
"""
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer

XRAY_API = os.environ.get("XRAY_API_SERVER", "127.0.0.1:10085")


def query() -> dict:
    """خروجی: {"u<id>": {"up": n, "down": n}, "total": {...}}"""
    out = {}
    try:
        res = subprocess.run(
            ["xray", "api", "statsquery", f"--server={XRAY_API}",
             "--pattern=user>>"],
            capture_output=True, text=True, timeout=5,
        )
        data = json.loads(res.stdout or "{}")
        for item in data.get("stat", []):
            name = item.get("name", "")
            value = int(item.get("value", 0))
            parts = name.split(">>>")
            if len(parts) >= 3 and parts[0] == "user":
                user, direction = parts[1], parts[2]
                d = out.setdefault(user, {"up": 0, "down": 0})
                d["up" if direction == "uplink" else "down"] += value
    except Exception as e:
        out["_error"] = str(e)
    return out


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(query()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", 9000), Handler)
    print("stats sidecar on :9000", flush=True)
    server.serve_forever()
