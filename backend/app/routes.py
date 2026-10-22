"""API پنل + سرویس اشتراک عمومی."""
import base64
import os
import time
from datetime import timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from . import auth, subscription, xray_config
from .models import Admin, PanelUser, AccessLog, engine, now

router = APIRouter()

STATS_URL = os.environ.get("STATS_URL", "http://soosh-stats:9000/stats")
PUBLIC_DOMAIN = os.environ.get("PUBLIC_DOMAIN", "example.com")


# ---------- مدل‌های ورودی ----------
class LoginIn(BaseModel):
    username: str
    password: str
    totp: str = ""


class TotpIn(BaseModel):
    code: str


class UserIn(BaseModel):
    username: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    note: str = Field(default="", max_length=500)
    traffic_limit_gb: float = Field(default=0.0, ge=0, le=100000)
    device_limit: int = Field(default=2, ge=1, le=100)
    expiry_days: int = Field(default=0, ge=0, le=3650)  # 0 = بدون انقضا
    active: bool = True
    inbound: str = Field(default="ws", pattern=r"^(ws|reality)$")
    path: str = Field(default="/ws", min_length=1, max_length=64, pattern=r"^/[A-Za-z0-9/_-]*$")
    sni: str = Field(default="", max_length=253)
    fingerprint: str = Field(default="chrome", pattern=r"^(chrome|firefox|safari|edge|random)$")
    flow: str = Field(default="", max_length=32)
    server_port: int = Field(default=443, ge=1, le=65535)
    reset_traffic: bool = False


def _user_json(u: PanelUser) -> dict:
    return {
        "id": u.id, "username": u.username, "note": u.note,
        "uuid": u.uuid, "active": u.active, "inbound": u.inbound,
        "used_gb": u.used_gb, "traffic_limit_gb": u.traffic_limit_gb,
        "device_limit": u.device_limit,
        "expiry": u.expiry.isoformat() if u.expiry else None,
        "expired": u.expired, "quota_exceeded": u.quota_exceeded,
        "sub_url": subscription.subscription_url(u),
        "vless": subscription.vless_uri(u, PUBLIC_DOMAIN),
        "path": u.path, "sni": u.sni, "fingerprint": u.fingerprint,
        "flow": u.flow, "server_port": u.server_port,
    }


# ---------- احراز هویت ----------
@router.post("/api/login")
def login(body: LoginIn, request: Request):
    ip = auth.client_ip(request)
    cutoff = now() - timedelta(minutes=1)
    with Session(engine) as s:
        # Persistent DB-backed limit (not a per-process in-memory counter).
        failures = s.query(func.count(AccessLog.id)).filter(
            AccessLog.ip == ip,
            AccessLog.action.in_(("login", "login-totp")),
            AccessLog.ok.is_(False),
            AccessLog.ts >= cutoff,
        ).scalar() or 0
        if failures >= 5:
            raise HTTPException(429, "تلاش‌های ورود بیش از حد؛ یک دقیقه بعد دوباره امتحان کنید")
        admin = s.query(Admin).filter_by(username=body.username).first()
        if not admin or not auth.verify_password(body.password, admin.password_hash):
            auth.log_action(body.username[:64], ip, "login", ok=False)
            raise HTTPException(401, "نام کاربری یا رمز اشتباه است")
        if admin.totp_enabled:
            if not body.totp or not auth.verify_totp(admin.totp_secret, body.totp):
                auth.log_action(body.username[:64], ip, "login-totp", ok=False)
                raise HTTPException(401, "کد دو مرحله‌ای نامعتبر است")
    auth.log_action(body.username[:64], ip, "login")
    return {"token": auth.create_token(admin.id), "totp_enabled": admin.totp_enabled}


@router.get("/api/2fa/setup")
def setup_2fa(request: Request, admin: Admin = Depends(auth.get_current_admin)):
    if admin.totp_enabled:
        raise HTTPException(400, "2FA از قبل فعال است")
    secret = auth.new_totp_secret()
    with Session(engine) as s:
        a = s.get(Admin, admin.id)
        a.totp_secret = secret
        s.commit()
    return {"secret": secret, "otpauth_url": auth.provisioning_uri(secret, admin.username)}


@router.post("/api/2fa/enable")
def enable_2fa(body: TotpIn, admin: Admin = Depends(auth.get_current_admin)):
    if not auth.verify_totp(admin.totp_secret, body.code):
        raise HTTPException(400, "کد نامعتبر است")
    with Session(engine) as s:
        a = s.get(Admin, admin.id)
        a.totp_enabled = True
        s.commit()
    auth.log_action(admin.username, "", "2fa-enabled")
    return {"ok": True}


# ---------- CRUD کاربران ----------
@router.get("/api/users")
def list_users(_=Depends(auth.get_current_admin)):
    with Session(engine) as s:
        return [_user_json(u) for u in s.query(PanelUser).all()]


@router.post("/api/users")
def create_user(body: UserIn, _=Depends(auth.get_current_admin)):
    with Session(engine) as s:
        if s.query(PanelUser).filter_by(username=body.username).first():
            raise HTTPException(400, "نام کاربری تکراری است")
        u = PanelUser(
            username=body.username, note=body.note,
            traffic_limit_gb=body.traffic_limit_gb, device_limit=body.device_limit,
            active=body.active, inbound=body.inbound, path=body.path,
            sni=body.sni, fingerprint=body.fingerprint, flow=body.flow,
            server_port=body.server_port,
            expiry=now() + __import__("datetime").timedelta(days=body.expiry_days)
            if body.expiry_days else None,
        )
        s.add(u)
        s.commit()
        out = _user_json(u)
    xray_config.write_config()
    return out


@router.put("/api/users/{uid}")
def update_user(uid: int, body: UserIn, _=Depends(auth.get_current_admin)):
    with Session(engine) as s:
        u = s.get(PanelUser, uid)
        if not u:
            raise HTTPException(404, "کاربر یافت نشد")
        for f in ("note", "traffic_limit_gb", "device_limit", "active", "inbound",
                  "path", "sni", "fingerprint", "flow", "server_port"):
            setattr(u, f, getattr(body, f))
        if body.expiry_days:
            import datetime as dt
            u.expiry = dt.datetime.utcnow() + dt.timedelta(days=body.expiry_days)
        if body.reset_traffic:
            u.used_uplink = u.used_downlink = 0
        s.commit()
        out = _user_json(u)
    xray_config.write_config()
    return out


@router.delete("/api/users/{uid}")
def delete_user(uid: int, _=Depends(auth.get_current_admin)):
    with Session(engine) as s:
        u = s.get(PanelUser, uid)
        if not u:
            raise HTTPException(404, "کاربر یافت نشد")
        s.delete(u)
        s.commit()
    xray_config.write_config()
    return {"ok": True}


# ---------- آمار لحظه‌ای ----------
async def _fetch_stats() -> dict:
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(STATS_URL)
            return r.json()
    except Exception:
        return {}


@router.get("/api/stats")
async def stats(_=Depends(auth.get_current_admin)):
    per_user = await _fetch_stats()   # {"u<id>": {"up": n, "down": n}}
    report = []
    with Session(engine) as s:
        for u in s.query(PanelUser).all():
            st = per_user.get(f"u{u.id}", {})
            session_up = int(st.get("up", 0))
            session_down = int(st.get("down", 0))
            # تجمعی‌سازی
            u.used_uplink = max(u.used_uplink, session_up)
            u.used_downlink = max(u.used_downlink, session_down)
            s.commit()
            online = (session_up + session_down) > 0 and u.is_online_allowed
            report.append({
                "id": u.id, "username": u.username, "active": u.active,
                "online": online, "used_gb": u.used_gb,
                "limit_gb": u.traffic_limit_gb,
                "expired": u.expired, "quota_exceeded": u.quota_exceeded,
            })
        # سهمیه اتمام‌شده → غیرفعال و حذف از کانفیگ
        changed = False
        for u in s.query(PanelUser).all():
            if not u.is_online_allowed and u.active:
                u.active = False
                changed = True
        if changed:
            s.commit()
    xray_config.write_config()
    return {"users": report, "ts": int(time.time())}


@router.get("/api/logs")
def logs(_=Depends(auth.get_current_admin)):
    with Session(engine) as s:
        rows = s.query(AccessLog).order_by(AccessLog.id.desc()).limit(100).all()
        return [{"ts": r.ts.isoformat(), "user": r.username, "ip": r.ip,
                 "action": r.action, "ok": r.ok} for r in rows]


# ---------- اشتراک عمومی (بدون احراز هویت — با توکن) ----------
@router.get("/sub/{token}")
def get_subscription(token: str, request: Request):
    with Session(engine) as s:
        u = s.query(PanelUser).filter_by(sub_token=token).first()
        if not u or not u.is_online_allowed:
            raise HTTPException(404, "اشتراک نامعتبر است")
        links = subscription.vless_uri(u, PUBLIC_DOMAIN)
        s.add(AccessLog(username=u.username, ip=auth.client_ip(request),
                        action="sub-fetch"))
        s.commit()
    return Response(base64.b64encode(links.encode()).decode(), media_type="text/plain")


@router.get("/sub/{token}/qr")
def sub_qr(token: str):
    with Session(engine) as s:
        u = s.query(PanelUser).filter_by(sub_token=token).first()
        if not u:
            raise HTTPException(404)
    svg = subscription.qr_svg(subscription.vless_uri(u, PUBLIC_DOMAIN))
    return Response(svg, media_type="image/svg+xml")
