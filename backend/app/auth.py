"""احراز هویت: PBKDF2، JWT کوتاه‌مدت، TOTP (2FA)، لاگ دسترسی."""
import os
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import jwt
import pyotp
from fastapi import HTTPException, Request

from .models import Admin, AccessLog, engine
from sqlalchemy.orm import Session

JWT_SECRET = os.environ["SECRET_KEY"]
JWT_ALG = "HS256"
SESSION_MINUTES = 30


# ---------- پسورد ----------
def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    iters = 240_000
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iters)
    return f"pbkdf2:{iters}:{salt}:{dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt, hexpb = stored.split(":")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iters))
        return hmac.compare_digest(dk.hex(), hexpb)
    except Exception:
        return False


# ---------- JWT ----------
def create_token(admin_id: int) -> str:
    payload = {
        "sub": str(admin_id),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=SESSION_MINUTES),
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, JWT_SECRET, JWT_ALG)


def get_current_admin(request: Request) -> Admin:
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "unauthorized")
    try:
        payload = jwt.decode(token, JWT_SECRET, [JWT_ALG])
    except jwt.PyJWTError:
        raise HTTPException(401, "session expired")
    with Session(engine) as s:
        admin = s.get(Admin, int(payload["sub"]))
        if not admin:
            raise HTTPException(401, "unknown admin")
        return admin


# ---------- TOTP ----------
def new_totp_secret() -> str:
    return pyotp.random_base32()


def provisioning_uri(secret: str, username: str) -> str:
    return pyotp.totp.TOTP(secret).provisioning_uri(name=username, issuer_name="SooshPanel")


def verify_totp(secret: str, code: str) -> bool:
    if not secret:
        return False
    return pyotp.TOTP(secret).verify(code, valid_window=1)


# ---------- لاگ دسترسی ----------
def log_action(username: str, ip: str, action: str, ok: bool = True) -> None:
    with Session(engine) as s:
        s.add(AccessLog(username=username, ip=ip, action=action, ok=ok))
        s.commit()


def client_ip(request: Request) -> str:
    fwd = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "?"
