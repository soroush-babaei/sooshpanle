# SooshPanel روی Cloudflare — کاملاً رایگان، بدون VPS و کارت بانکی

نسخه‌ای از پنل که **کل آن (پنل + هسته پروکسی + دیتابیس) داخل Cloudflare Workers** اجرا می‌شود.

## چی کار می‌کند

- پروتکل **VLESS + WebSocket + TLS** (پشت CDN خود CF — مثل edgetunnel)
- پنل وب فارسی RTL + API ادمین
- دیتابیس **D1** (رایگان) — کاربران، لاگ، توکن اشتراک
- لینک اشتراک `/sub/<token>` سازگار با v2rayNG/Hiddify/Streisand

## محدودیت‌های پلتفرم (صادقانه)

- ❌ **Reality نداریم** — Workers فقط WebSocket از CDN پشتیبانی می‌کند
- ❌ شمارش دقیق بایت مصرفی هر کاربر ممکن نیست → فیلد سهمیه صرفاً نمایشی است و **سهمیهٔ ترافیک اعمال نمی‌شود**.
- ❌ محدودیت تعداد دستگاه/اتصال هم‌زمان هم پیاده‌سازی نشده است؛ یک UUID مشترک هویت دستگاه‌ها را از هم جدا نمی‌کند.
- ⚠️ این نسخه برای مدیریت واقعی سهمیه و محدودیت دستگاه آماده نیست. برای سهمیهٔ مبتنی بر بایت، از backend/Xray استفاده کنید و قبل از انتشار عمومی تست staging اجرا کنید.
- ⚡ سرعت به شبکه، منطقه و محدودیت‌های جاری سرویس وابسته است؛ عدد ثابتی تضمین نمی‌شود.

---

## استقرار — فقط با داشبورد (بدون نصب هیچ‌چیز)

### ۱) ساخت Worker

1. [dash.cloudflare.com](https://dash.cloudflare.com) → ثبت‌نام/ورود (فقط ایمیل)
2. **Workers & Pages** → **Create application** → **Create Worker**
3. نام: `sooshpanel` → **Deploy**
4. **Edit code** → محتوای فایل `cloudflare/worker.js` را **کامل جایگزین** کد پیش‌فرض کنید → **Save and Deploy**

### ۲) ساخت دیتابیس D1

1. داشبورد → **Storage & Databases** → **D1 SQL Database** → **Create**
2. نام: `soosh-db` → Create
3. از صفحه دیتابیس، **Settings → Bindings** (یا در Worker: **Settings → Bindings → Add → D1**) → متغیر `DB` را به دیتابیس `soosh-db` وصل کنید

### ۳) متغیرهای محیطی

در Worker → **Settings → Variables and Secrets** → دو متغیر اضافه کنید:

| نام              | مقدار                            |
| ---------------- | -------------------------------- |
| `ADMIN_USERNAME` | `admin`                          |
| `ADMIN_PASSWORD` | یک رمز قوی                       |
| `SECRET_KEY`     | یک رشته تصادفی (برای امضای نشست) |

→ **Deploy** دوباره بزنید.

### ۴) تست

- `https://sooshpanel.<حساب>.workers.dev/` → باید پنل را ببینید
- ورود با نام/رمز بالا
- کاربر بسازید → لینک کانفیگ تولید می‌شود
- لینک را در v2rayNG: ➕ → **Import from clipboard**

### ۵) اگر pages.dev / workers.dev فیلتر بود

یک دامنه بخرید، به CF بدهید و در Worker → **Settings → Domains & Routes → Add → Custom Domain** وصل کنید. کانفیگ‌ها خودکار روی دامنه جدید کار می‌کنند (چون دامنه در لینک‌ها از `location.hostname` گرفته می‌شود).

---

## استقرار با wrangler (اختیاری، برای توسعه)

```bash
npm i -g wrangler
wrangler login
wrangler d1 create soosh-db          # database_id را کپی کنید
# wrangler.toml را ویرایش کنید (database_id)
wrangler deploy
```

محتوای `wrangler.toml`:

```toml
name = "sooshpanel"
main = "worker.js"
compatibility_date = "2024-09-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "soosh-db"
database_id = "<ID-از-مرحله-قبل>"

[vars]
ADMIN_USERNAME = "admin"
# ADMIN_PASSWORD و SECRET_KEY را با secret بگذارید:
# wrangler secret put ADMIN_PASSWORD
# wrangler secret put SECRET_KEY
```

---

## سؤال‌های پرتکرار

**کانفیگ‌ها واقعاً روی همراه اول/ایرانسل کار می‌کنند؟**
بله — همان مسیر VLESS+WS+TLS که پنل‌های معروف (edgetunnel و…) استفاده می‌کنند. ترافیک شما از CDN خود CF می‌گذرد.

**چرا Reality نداریم؟** Workers نمی‌تواند پورت TCP خام منتشر کند. Reality به VPS واقعی نیاز دارد.

**آیا سهمیه و محدودیت تعداد دستگاه اعمال می‌شود؟** خیر. در نسخه CF سهمیه فقط فیلد نمایشی است و تعداد دستگاه هم‌زمان هم enforce نمی‌شود. برای سهمیهٔ مبتنی بر ترافیک از backend/Xray استفاده کنید؛ محدودیت دستگاه در backend فعلی نیز هنوز enforce نمی‌شود و نباید به کاربران به‌عنوان ویژگی تضمین‌شده معرفی شود.

**هزینه؟** Workers رایگان: ۱۰۰,۰۰۰ درخواست/روز + D1 رایگان — برای استفاده شخصی بسیار کافی است.
