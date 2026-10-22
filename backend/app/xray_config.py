"""مولد config.json برای Xray-core — اینباندهای VLESS+WS و VLESS+Reality."""
import os
import json

from .models import PanelUser, engine
from sqlalchemy.orm import Session

XRAY_CONFIG_PATH = os.environ.get("XRAY_CONFIG_PATH", "/xray/config.json")

# SNI پیش‌فرض برای Reality — دامنه‌ای خارج که TLS واقعی دارد
REALITY_SNI = os.environ.get("REALITY_SNI", "www.datadoghq.com")
REALITY_KEY = os.environ.get("REALITY_PRIVKEY", "")   # xray x25519 → Private key
REALITY_PUBKEY = os.environ.get("REALITY_PUBKEY", "")


def _clients_for(inbound: str) -> list[dict]:
    """کاربران مجاز اینباند (فقط کاربران فعال با سهمیه باقی‌مانده)."""
    from .models import init_db
    init_db()
    with Session(engine) as s:
        users = s.query(PanelUser).filter(
            PanelUser.active == True, PanelUser.inbound == inbound  # noqa: E712
        ).all()
        return [{"id": u.uuid, "email": f"u{u.id}", "flow": u.flow if inbound == "reality" else ""}
                for u in users if u.is_online_allowed]


def build_config() -> dict:
    ws_clients = _clients_for("ws")
    rl_clients = _clients_for("reality")

    inbound_ws = {
        "tag": "in-ws",
        "listen": "0.0.0.0",
        "port": 8080,
        "protocol": "vless",
        "settings": {"clients": ws_clients, "decryption": "none"},
        "streamSettings": {
            "network": "ws",
            "security": "none",
            "wsSettings": {"path": os.environ.get("WS_PATH", "/ws")},
        },
        "sniffing": {"enabled": True, "destOverride": ["http", "tls"]},
    }

    inbound_reality = {
        "tag": "in-reality",
        "listen": "0.0.0.0",
        "port": 8443,
        "protocol": "vless",
        "settings": {"clients": rl_clients, "decryption": "none"},
        "streamSettings": {
            "network": "tcp",
            "security": "reality",
            "sockopt": {"tcpFastOpen": True, "tcpNoDelay": True},
            "realitySettings": {
                "show": False,
                "dest": f"{REALITY_SNI}:443",
                "xver": 0,
                "serverNames": [REALITY_SNI],
                "privateKey": REALITY_KEY,
                "shortIds": ["", "01", "abcd"],
                "maxTimeDifference": 0,
                "spiderX": "/",
            },
        },
    }

    return {
        "log": {"loglevel": "warning", "access": os.environ.get("XRAY_ACCESS_LOG", "")},
        "api": {"tag": "api", "services": ["StatsService"]},
        "stats": {},
        "policy": {
            "levels": {"0": {
                "statsUserUplink": True,
                "statsUserDownlink": True,
            }},
            "system": {
                "statsInboundUplink": True,
                "statsInboundDownlink": True,
            },
        },
        "inbounds": [inbound_ws, inbound_reality, {
            "tag": "api-in",
            "listen": "0.0.0.0",
            "port": 10085,
            "protocol": "dokodemo-door",
            "settings": {"address": "127.0.0.1"},
        }],
        "routing": {"rules": [{"type": "field", "inboundTag": ["api-in"],
                               "outboundTag": "api"}]},
        "outbounds": [
            {"tag": "direct", "protocol": "freedom"},
            {"tag": "blocked", "protocol": "blackhole"},
        ],
    }


def _try_restart_core() -> bool:
    """Xray کانفیگ را هات‌ریلود نمی‌کند؛ اگر سوکت Docker مانت شده باشد، هسته را ری‌استارت می‌کنیم."""
    sock = os.environ.get("DOCKER_SOCK", "")
    if not sock:
        return False
    try:
        import socket as _s
        req = (f"POST /containers/soosh-xray/restart?t=2 HTTP/1.1\r\n"
               f"Host: docker\r\nContent-Length: 0\r\n\r\n").encode()
        client = _s.socket(_s.AF_UNIX, _s.SOCK_STREAM)
        client.settimeout(10)
        client.connect(sock)
        client.sendall(req)
        client.recv(256)
        client.close()
        return True
    except Exception:
        return False


def write_config() -> bool:
    """بازنویسی config.json و ری‌لود هسته (در صورت وجود docker.sock)."""
    cfg = build_config()
    try:
        os.makedirs(os.path.dirname(XRAY_CONFIG_PATH), exist_ok=True)
        tmp = XRAY_CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, XRAY_CONFIG_PATH)
        _try_restart_core()
        return True
    except OSError:
        return False
