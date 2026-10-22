"""مدل‌های دیتابیس — SQLAlchemy 2.0 + SQLite (WAL)."""
import os
import secrets
import uuid as _uuid
import time
from datetime import datetime, timedelta

from sqlalchemy import create_engine, String, Integer, Boolean, DateTime, Text, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, Session

DB_PATH = os.environ.get("DB_PATH", "/data/soosh.db")
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})

# WAL برای خواندن/نوشتن هم‌زمان بدون قفل
@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.close()


class Base(DeclarativeBase):
    pass


def now() -> datetime:
    return datetime.utcnow()


class Admin(Base):
    __tablename__ = "admins"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(256))   # pbkdf2:iterations:salt:hash
    totp_secret: Mapped[str] = mapped_column(String(64), default="")
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class PanelUser(Base):
    """کاربر کانفیگ."""
    __tablename__ = "panel_users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    note: Mapped[str] = mapped_column(Text, default="")
    uuid: Mapped[str] = mapped_column(String(64), default=lambda: str(_uuid.uuid4()))
    # سهمیه‌ها
    traffic_limit_gb: Mapped[float] = mapped_column(default=0.0)  # 0 = بی‌نهایت
    used_uplink: Mapped[int] = mapped_column(default=0)           # بایت
    used_downlink: Mapped[int] = mapped_column(default=0)         # بایت
    device_limit: Mapped[int] = mapped_column(default=2)          # اتصال هم‌زمان
    expiry: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    sub_token: Mapped[str] = mapped_column(String(64), unique=True,
                                           default=lambda: secrets.token_urlsafe(24))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    # ویژگی‌های کانفیگ قابل تغییر از پنل
    protocol: Mapped[str] = mapped_column(String(16), default="vless")
    inbound: Mapped[str] = mapped_column(String(16), default="ws")     # ws | reality
    path: Mapped[str] = mapped_column(String(64), default="/ws")
    sni: Mapped[str] = mapped_column(String(128), default="")
    fingerprint: Mapped[str] = mapped_column(String(32), default="chrome")
    flow: Mapped[str] = mapped_column(String(32), default="")          # xtls-rprx-vision برای reality
    server_port: Mapped[int] = mapped_column(Integer, default=443)

    @property
    def used_bytes(self) -> int:
        return self.used_uplink + self.used_downlink

    @property
    def used_gb(self) -> float:
        return round(self.used_bytes / 1e9, 2)

    @property
    def expired(self) -> bool:
        return self.expiry is not None and self.expiry < now()

    @property
    def quota_exceeded(self) -> bool:
        return (self.traffic_limit_gb > 0 and
                self.used_bytes >= self.traffic_limit_gb * 1e9)

    @property
    def is_online_allowed(self) -> bool:
        return self.active and not self.expired and not self.quota_exceeded


class AccessLog(Base):
    __tablename__ = "access_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=now)
    username: Mapped[str] = mapped_column(String(64), default="")
    ip: Mapped[str] = mapped_column(String(64), default="")
    action: Mapped[str] = mapped_column(String(128), default="")
    ok: Mapped[bool] = mapped_column(Boolean, default=True)


def init_db() -> None:
    Base.metadata.create_all(engine)
    # ادمین اولیه از .env
    from . import auth  # noqa: F401
    with Session(engine) as s:
        if not s.query(Admin).first():
            s.add(Admin(
                username=os.environ["ADMIN_USERNAME"],
                password_hash=auth.hash_password(os.environ["ADMIN_PASSWORD"]),
            ))
            s.commit()
