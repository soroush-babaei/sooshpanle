"""SooshPanel — اپ FastAPI."""
import os
import asyncio
import logging

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .models import init_db, engine
from .routes import router
from . import xray_config, routes

BASE = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="SooshPanel", docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(router)
app.mount("/static", StaticFiles(directory=os.path.join(BASE, "..", "static")), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(BASE, "..", "static", "index.html"))


logger = logging.getLogger("sooshpanel")
_sync_task = None


async def _usage_sync_loop():
    interval = max(10, int(os.environ.get("USAGE_SYNC_SECONDS", "15")))
    while True:
        try:
            await routes.stats()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Periodic usage/expiry synchronization failed")
        await asyncio.sleep(interval)


@app.on_event("startup")
async def startup():
    global _sync_task
    init_db()
    if os.path.exists(os.path.dirname(xray_config.XRAY_CONFIG_PATH)):
        xray_config.write_config()
    _sync_task = asyncio.create_task(_usage_sync_loop())


@app.on_event("shutdown")
async def shutdown():
    global _sync_task
    if _sync_task:
        _sync_task.cancel()
        try:
            await _sync_task
        except asyncio.CancelledError:
            pass
        _sync_task = None


@app.middleware("http")
async def security_headers(request, call_next):
    resp = await call_next(request)
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    return resp
