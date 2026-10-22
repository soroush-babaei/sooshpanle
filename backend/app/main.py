"""SooshPanel — اپ FastAPI."""
import os

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .models import init_db, engine
from .routes import router
from . import xray_config

BASE = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="SooshPanel", docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(router)
app.mount("/static", StaticFiles(directory=os.path.join(BASE, "..", "static")), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(BASE, "..", "static", "index.html"))


@app.on_event("startup")
def startup():
    init_db()
    if os.path.exists(os.path.dirname(xray_config.XRAY_CONFIG_PATH)):
        xray_config.write_config()
    engine.dispose is None  # no-op نگهداری سازگاری


@app.middleware("http")
async def security_headers(request, call_next):
    resp = await call_next(request)
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    return resp
