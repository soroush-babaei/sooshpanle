"""لینک اشتراک (VLESS URI) و QR سمت سرور."""
import base64
import os
import urllib.parse

import qrcode

from .models import PanelUser

PUBLIC_DOMAIN = os.environ.get("PUBLIC_DOMAIN", "example.com")
SUB_BASE = os.environ.get("SUB_BASE_URL", "")  # اگر خالی باشد از PUBLIC_DOMAIN ساخته می‌شود


def vless_uri(u: PanelUser, host: str | None = None) -> str:
    host = host or PUBLIC_DOMAIN
    params = {
        "type": "ws" if u.inbound == "ws" else "tcp",
        "security": "none" if u.inbound == "ws" else "reality",
        "encryption": "none",
        "fp": u.fingerprint or "chrome",
    }
    if u.inbound == "ws":
        # Cloudflare در لبه TLS را خاتمه می‌دهد؛ کلاینت باید security=tls بزند
        params.update({"security": "tls", "host": host,
                       "path": u.path or "/ws", "sni": u.sni or host})
    else:
        params.update({
            "sni": u.sni or os.environ.get("REALITY_SNI", "www.datadoghq.com"),
            "pbk": os.environ.get("REALITY_PUBKEY", ""),
            "flow": u.flow or "xtls-rprx-vision",
            "sid": "01",
        })
    query = urllib.parse.urlencode(params)
    name = urllib.parse.quote(f"{u.username}|SooshPanel")
    return f"vless://{u.uuid}@{host}:{u.server_port}?{query}#{name}"


def subscription_body(users: list[PanelUser]) -> str:
    links = "\n".join(vless_uri(u) for u in users)
    return base64.b64encode(links.encode()).decode()


def subscription_url(u: PanelUser) -> str:
    base = SUB_BASE_URL()
    return f"{base}/sub/{u.sub_token}"


def SUB_BASE_URL() -> str:
    return SUB_BASE or f"https://{PUBLIC_DOMAIN}"


def qr_svg(data: str) -> str:
    """SVG بدون وابستگی به CDN — برای نمایش در پنل و اپ‌ها."""
    qr = qrcode.QRCode(border=1, box_size=1)
    qr.add_data(data)
    qr.make(fit=True)
    m = qr.get_matrix()
    n = len(m)
    rects = "".join(
        f'<rect x="{x}" y="{y}" width="1" height="1"/>'
        for y, row in enumerate(m) for x, v in enumerate(row) if v
    )
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" '
            f'shape-rendering="crispEdges" fill="#000">'
            f'<rect width="{n}" height="{n}" fill="#fff"/>{rects}</svg>')
