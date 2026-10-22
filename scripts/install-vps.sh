#!/usr/bin/env bash
# SooshPanel — نصب خودکار روی VPS اوبونتو (دبیان) با Cloudflare Tunnel
# اجرا:  bash install-vps.sh
set -euo pipefail

cd "$(dirname "$0")/.."   # ریشه پروژه

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

# ── ۱) Docker ────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "نصب Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

# ── ۲) ساخت/به‌روزرسانی .env ─────────────────────────────────
log "آماده‌سازی .env"
if [[ ! -f .env ]]; then
  cp .env.example .env
  SECRET=$(openssl rand -hex 32)
  PASS=$(openssl rand -base64 18 | tr -dc 'a-zA-Z0-9' | head -c 16)
  sed -i "s|^SECRET_KEY=.*|SECRET_KEY=${SECRET}|" .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${PASS}|" .env
  echo "  → رمز ادمین تولیدشده: ${PASS}   (ذخیره کنید!)"
fi

# ── ۳) کلیدهای Reality (x25519) ──────────────────────────────
log "تولید کلیدهای Reality"
KEYS=$(docker run --rm teddysun/xray:latest xray x25519 2>/dev/null || true)
PRIV=$(echo "$KEYS" | grep -oP 'Private key: \K.*')
PUB=$(echo "$KEYS"  | grep -oP 'Public key:  \K.*')
if [[ -n "${PRIV:-}" && -n "${PUB:-}" ]]; then
  sed -i "s|^REALITY_PRIVKEY=.*|REALITY_PRIVKEY=${PRIV}|" .env
  sed -i "s|^REALITY_PUBKEY=.*|REALITY_PUBKEY=${PUB}|" .env
  echo "  → Public key (برای لینک‌ها): ${PUB}"
else
  echo "  ! کلیدها ساخته نشد؛ بعداً دستی بگیرید: docker run --rm teddysun/xray xray x25519"
fi

# ── ۴) اجرای استک ────────────────────────────────────────────
log "اجرای docker compose"
docker compose up -d --build

# ── ۵) فایروال ───────────────────────────────────────────────
log "پیکربندی فایروال"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 8443/tcp >/dev/null 2>&1 || true   # Reality
  # پنل و WS از طریق تونل CF می‌روند؛ پورت باز لازم نیست
  ufw --force enable >/dev/null 2>&1 || true
fi

# ── ۶) تونل Cloudflare (اختیاری، توکن از داشبورد CF) ────────
log "تونل Cloudflare"
read -rp "CF_TUNNEL_TOKEN را وارد کنید (خالی = رد شدن): " TUNNEL || true
if [[ -n "${TUNNEL:-}" ]]; then
  sed -i "s|^CF_TUNNEL_TOKEN=.*|CF_TUNNEL_TOKEN=${TUNNEL}|" .env
  docker compose up -d tunnel
  echo "  → تونل فعال شد. در داشبورد CF مسیرها را تنظیم کنید:"
  echo "     panel.example.com  →  http://sooshpanel:8000"
  echo "     xray.example.com   →  http://soosh-xray:8080"
else
  echo "  → رد شد. پنل فعلاً روی http://SERVER_IP:8000 در دسترس است."
fi

log "پایان! "
echo "  پنل:      http://SERVER_IP:8000  (یا دامنه تونل)"
echo "  لاگ‌ها:    docker compose logs -f"
echo "  ری‌استارت: docker compose restart"
