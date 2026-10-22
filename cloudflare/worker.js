/**
 * SooshPanel — نسخه کامل روی Cloudflare Workers (رایگان، بدون VPS)
 * ================================================================
 * همه‌چیز در یک فایل:
 *   1) هسته پروکسی VLESS + WebSocket (جایگزین Xray)
 *   2) پنل وب + API ادمین (CRUD کاربران، حجم، انقضا)
 *   3) دیتابیس D1 + لینک اشتراک
 *
 * استقرار:
 *   داشبورد CF → Workers → Create Worker → محتوای این فایل را Paste کنید
 *   سپس: Settings → Bindings → D1 (نام: DB) + Variables:
 *        ADMIN_PASSWORD، ADMIN_USERNAME
 *   (راهنمای کامل: cloudflare/README-CF.md)
 */

import { connect } from "cloudflare:sockets";

// ───────────────────────── تنظیمات ─────────────────────────
const WS_PATH = "/ws";        // مسیر پروکسی
const SESSION_MIN = 60;       // عمر نشست ادمین (دقیقه)

// ───────────────────────── ابزار ───────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
const b64 = (s) => btoa(String.fromCharCode(...enc.encode(s)));
const unb64 = (s) => dec.decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const hex = (n) => [...new Uint8Array(n)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const uuidv4 = () => crypto.randomUUID();

// ───────────────────────── JWT (WebCrypto) ─────────────────
async function jwtSign(payload, secret) {
  const data = enc.encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  const b64u = (a) => btoa(String.fromCharCode(...new Uint8Array(a))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64u(data)}.${b64u(sig)}`;
}
function decodeB64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}
async function jwtVerify(token, secret) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const payloadBytes = decodeB64Url(parts[0]);
    const signature = decodeB64Url(parts[1]);
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const valid = await crypto.subtle.verify("HMAC", key, signature, payloadBytes);
    if (!valid) return null;
    const payload = JSON.parse(dec.decode(payloadBytes));
    if (!payload || payload.role !== "admin" || !Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ───────────────────────── D1 ──────────────────────────────
async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      note TEXT DEFAULT '',
      uuid TEXT UNIQUE NOT NULL,
      quota_gb REAL DEFAULT 0,
      expiry TEXT,
      active INTEGER DEFAULT 1,
      sub_token TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')),
      ip TEXT, user TEXT, action TEXT, ok INTEGER DEFAULT 1
    )`),
  ]);
}
async function log(db, ip, user, action, ok = 1) {
  try { await db.prepare("INSERT INTO logs (ip, user, action, ok) VALUES (?,?,?,?)").bind(ip, user, action, ok).run(); } catch { }
}
async function getUserByToken(db, token) {
  return db.prepare("SELECT * FROM users WHERE sub_token=?").bind(token).first();
}
async function getUserByUuid(db, uuid) {
  // VLESS carries UUID bytes without hyphens; D1 stores canonical UUID strings.
  const normalized = String(uuid).replace(/-/g, "").toLowerCase();
  return db.prepare("SELECT * FROM users WHERE lower(replace(uuid, '-', ''))=?")
    .bind(normalized).first();
}
function userAllowed(u) {
  if (!u || !u.active) return false;
  if (u.expiry && u.expiry < new Date().toISOString()) return false;
  return true; // مصرف دقیق بایت روی Workers قابل شمارش نیست — سهمیه با انقضا/فعال‌سازی کنترل می‌شود
}
async function touchUser(db, id) {
  try { await db.prepare("UPDATE users SET last_seen=datetime('now') WHERE id=?").bind(id).run(); } catch { }
}

// ───────────────────────── هسته VLESS ──────────────────────
async function handleVless(request, env, db) {
  const [client, upstream] = Object.values(new WebSocketPair());
  upstream.accept();

  let remote = null, remoteWriter = null, headerDone = false, userId = null;

  upstream.addEventListener("message", async (ev) => {
    if (remote) return; // فقط پیام اول هدر است
    let data;
    if (ev.data instanceof ArrayBuffer) data = new Uint8Array(ev.data);
    else if (typeof ev.data === "string") data = enc.encode(ev.data);
    else return;

    try {
      if (data[0] !== 0) throw new Error("bad vless version");
      const uuid = hex(data.slice(1, 17));
      const user = await getUserByUuid(db, uuid);
      if (!userAllowed(user)) { upstream.close(1008, "unauthorized"); return; }
      userId = user.id;
      touchUser(db, userId);

      let i = 17;
      const optLen = data[i]; i += 1;
      i += optLen; // addons (path) — چون WS path قبلاً چک می‌شود نادیده
      const command = data[i]; i += 1;              // 1=TCP, 2=UDP
      const port = (data[i] << 8) | data[i + 1]; i += 2;
      const atype = data[i]; i += 1;
      let host;
      if (atype === 1) { host = [...data.slice(i, i + 4)].join("."); i += 4; }
      else if (atype === 2) {
        const len = data[i]; i += 1;
        host = dec.decode(data.slice(i, i + len)); i += len;
      } else if (atype === 3) {
        const p = []; for (let j = 0; j < 8; j++) p.push(data[i + j * 2].toString(16) + data[i + j * 2 + 1].toString(16));
        host = p.join(":"); i += 16;
      } else throw new Error("bad atype");
      if (command === 2) { upstream.close(1008, "udp not supported"); return; }

      // پاسخ هدر VLESS
      const resp = new Uint8Array([0, 0]);
      upstream.send(resp.buffer);

      // اتصال TCP خروجی
      remote = connect({ hostname: host, port });
      remoteWriter = remote.writable.getWriter();
      await remoteWriter.write(data.slice(i)); // داده بعد از هدر
      remote.readable.pipeTo(new WritableStream({
        write: (chunk) => upstream.send(chunk),
        close: () => upstream.close(1000),
      })).catch(() => upstream.close(1000));

      // جریان کلاینت → مقصد
      headerDone = true;
      const reader = new ReadableStream({
        start(ctrl) { ctrl.enqueue(data.slice(i)); }
      }).getReader();
      // از این پس هر پیام بعدی مستقیم فرستاده می‌شود
      upstream.addEventListener("message", async (ev2) => {
        if (!remote) return;
        const d = ev2.data instanceof ArrayBuffer ? new Uint8Array(ev2.data) : enc.encode(ev2.data);
        try { await remoteWriter.write(d); } catch { }
      });
    } catch (e) {
      try { upstream.close(1011, String(e)); } catch { }
    }
  });

  upstream.addEventListener("close", () => { try { remote?.close(); } catch { } });
  return new Response(null, { status: 101, webSocket: client });
}

// ───────────────────────── اشتراک ──────────────────────────
function vlessUri(u, host) {
  const p = new URLSearchParams({
    type: "ws", security: "tls", encryption: "none",
    fp: "chrome", host, path: WS_PATH, sni: host,
  });
  return `vless://${u.uuid}@${host}:443?${p}#${encodeURIComponent(u.username + "|SooshPanel-CF")}`;
}

// ───────────────────────── احراز ادمین ─────────────────────
async function requireAdmin(request, env) {
  if (!env.SECRET_KEY || env.SECRET_KEY.length < 32) {
    throw new Response(JSON.stringify({ detail: "server authentication is not configured" }), {
      status: 503, headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  const p = match ? await jwtVerify(match[1], env.SECRET_KEY) : null;
  if (!p) throw new Response(JSON.stringify({ detail: "unauthorized" }), {
    status: 401, headers: { "content-type": "application/json; charset=utf-8" }
  });
  return p;
}
const catchAuth = (fn) => async (request, env, ctx, db) => {
  try { return await fn(request, env, db); }
  catch (e) { if (e instanceof Response) return e; throw e; }
};
const asAdmin = async (request, env, ctx, db) => {
  const admin = await catchAuth(requireAdmin)(request, env, ctx, db);
  if (admin instanceof Response) return admin;   // 401
  return admin;                                   // payload
};

// ───────────────────────── UI (تک‌فایل RTL) ────────────────
const UI = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>SooshPanel CF</title>
<style>
:root{--bg:#0f1218;--card:#1a1f2b;--fg:#e8eaf0;--acc:#4f8cff;--ok:#2ecc71;--bad:#e74c3c}
*{box-sizing:border-box;font-family:Vazirmatn,Tahoma,sans-serif}
body{background:var(--bg);color:var(--fg);margin:0;padding:20px}
.card{background:var(--card);border-radius:12px;padding:16px;margin-bottom:16px}
h1{font-size:20px}h2{font-size:16px;margin-top:0}
input,select{background:#11151d;color:var(--fg);border:1px solid #2a3040;border-radius:8px;padding:8px;margin:4px 0;width:100%}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:9px 14px;cursor:pointer;margin:4px 2px}
button.danger{background:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px;border-bottom:1px solid #2a3040;text-align:right}
.ok{color:var(--ok)}.bad{color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}
#loginBox{max-width:360px;margin:10vh auto}.muted{color:#8b93a5;font-size:12px}
</style></head><body>
<div id="loginBox" class="card"><h2>ورود ادمین</h2>
<input id="u" placeholder="نام کاربری"><input id="p" type="password" placeholder="رمز">
<button onclick="login()">ورود</button></div>
<div id="panel" style="display:none">
<div class="card" style="display:flex;justify-content:space-between;align-items:center">
<h1>☁️ SooshPanel (Cloudflare)</h1><div>
<button onclick="viewLogs()">لاگ</button><button class="danger" onclick="logout()">خروج</button></div></div>
<div class="card"><h2>افزودن کاربر</h2><div class="grid">
<input id="f_user" placeholder="نام کاربری"><input id="f_limit" type="number" placeholder="حجم (GB) - نمایشی">
<input id="f_exp" type="number" placeholder="انقضا (روز، 0=ندارد)"><input id="f_note" placeholder="یادداشت"></div>
<button onclick="addUser()">ایجاد</button></div>
<div class="card"><h2>کاربران</h2><div style="overflow-x:auto"><table id="tbl">
<thead><tr><th>کاربر</th><th>وضعیت</th><th>انقضا</th><th>لینک کانفیگ</th><th>اقدام</th></tr></thead><tbody></tbody></table></div>
<div class="muted">لینک کانفیگ را کپی و در v2rayNG/Hiddify import کنید.</div></div>
<div id="logsBox" class="card" style="display:none"><h2>لاگ</h2><table id="logtbl">
<thead><tr><th>زمان</th><th>IP</th><th>کاربر</th><th>اقدام</th><th>نتیجه</th></tr></thead><tbody></tbody></table></div>
</div>
<script>
let token=localStorage.getItem("t")||"";
const H=()=>({"Authorization":"Bearer "+token,"Content-Type":"application/json"});
async function login(){
 const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({username:u.value,password:p.value})});
 if(!r.ok){alert("ورود ناموفق");return}
 token=(await r.json()).token;localStorage.setItem("t",token);boot();
}
function logout(){localStorage.removeItem("t");location.reload()}
function boot(){loginBox.style.display="none";panel.style.display="block";refresh()}
async function refresh(){
 const [users,host]=await Promise.all([fetch("/api/users",{headers:H()}).then(r=>r.json()),
   Promise.resolve(location.hostname)]);
 const tb=tbl.querySelector("tbody");tb.innerHTML="";
 users.forEach(u=>{
  const st=!u.active?"⛔ غیرفعال":(u.expiry&&u.expiry<new Date().toISOString()?"⏰ منقضی":"🟢 فعال");
  tb.innerHTML+=\`<tr><td><b>\${u.username}</b><div class="muted">\${u.note||""}</div></td>
   <td class="\${u.active?'ok':'bad'}">\${st}</td><td>\${u.expiry?u.expiry.slice(0,10):"—"}</td>
   <td><a href="#" onclick="copyLink('\${u.uuid}');return false">کپی لینک</a>
       <div class="muted">/sub/\${u.sub_token.slice(0,8)}…</div></td>
   <td><button class="danger" onclick="del(\${u.id})">حذف</button>
       <button onclick="toggle(\${u.id},\${u.active})">\${u.active?'قطع':'وصل'}</button></td></tr>\`;
 });
}
function copyLink(uuid){navigator.clipboard.writeText(
  \`vless://\${uuid}@\${location.hostname}:443?type=ws&security=tls&encryption=none&fp=chrome&host=\${location.hostname}&path=/ws&sni=\${location.hostname}#soosh\`);
 alert("لینک کپی شد — در v2rayNG: Import from clipboard")}
async function addUser(){
 const r=await fetch("/api/users",{method:"POST",headers:H(),
  body:JSON.stringify({username:f_user.value,quota_gb:+f_limit.value||0,
   expiry_days:+f_exp.value||0,note:f_note.value})});
 if(!r.ok){alert((await r.json()).detail||"خطا");return} f_user.value="";refresh()}
async function del(id){if(!confirm("حذف شود؟"))return;
 await fetch("/api/users/"+id,{method:"DELETE",headers:H()});refresh()}
async function toggle(id,active){
 await fetch("/api/users/"+id,{method:"PUT",headers:H(),body:JSON.stringify({active:!active})});refresh()}
async function viewLogs(){
 const logs=await fetch("/api/logs",{headers:H()}).then(r=>r.json());
 logsBox.style.display="block";
 logtbl.querySelector("tbody").innerHTML=logs.map(l=>
  \`<tr><td>\${l.ts}</td><td>\${l.ip}</td><td>\${l.user}</td><td>\${l.action}</td>
   <td class="\${l.ok?'ok':'bad'}">\${l.ok?'✔':'✘'}</td></tr>\`).join("")}
if(token)boot();
</script></body></html>`;

// ───────────────────────── روتر اصلی ───────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const db = env.DB;
    const ip = request.headers.get("cf-connecting-ip") || "?";

    if (!db) return json({ detail: "D1 binding DB is not configured" }, 503);

    // 1) پروکسی VLESS روی مسیر WS
    if (url.pathname === WS_PATH) {
      if (request.headers.get("Upgrade") !== "websocket") return json({ detail: "websocket only" }, 400);
      return handleVless(request, env, db);
    }

    // 2) اشتراک عمومی
    if (url.pathname.startsWith("/sub/")) {
      const token = url.pathname.split("/")[2];
      const u = await getUserByToken(db, token);
      if (!u || !userAllowed(u)) return new Response("invalid", { status: 404 });
      const body = b64(vlessUri(u, url.hostname) + "\n");
      return new Response(body, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "subscription-userinfo": `upload=0; download=0; total=${Math.round((u.quota_gb || 0) * 1e9)}; expire=${u.expiry ? Math.floor(new Date(u.expiry).getTime() / 1000) : 0}`,
          "profile-update-interval": "6"
        },
      });
    }

    // 3) UI
    if (url.pathname === "/") return new Response(UI, { headers: { "content-type": "text/html; charset=utf-8" } });

    // 4) API
    await ensureSchema(db);

    if (url.pathname === "/api/login" && request.method === "POST") {
      if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.SECRET_KEY || env.SECRET_KEY.length < 32) {
        return json({ detail: "تنظیمات احراز هویت سرور کامل نیست" }, 503);
      }
      let body;
      try { body = await request.json(); } catch { return json({ detail: "درخواست نامعتبر" }, 400); }
      const { username, password } = body || {};
      if (typeof username !== "string" || typeof password !== "string" ||
          username.length > 128 || password.length > 1024) {
        return json({ detail: "نام کاربری یا رمز اشتباه است" }, 401);
      }
      const okU = username === env.ADMIN_USERNAME;
      const okP = password === env.ADMIN_PASSWORD;
      await log(db, ip, username || "?", "login", okU && okP ? 1 : 0);
      if (!okU || !okP) return json({ detail: "نام کاربری یا رمز اشتباه است" }, 401);
      const token = await jwtSign({ role: "admin", exp: Date.now() + SESSION_MIN * 60_000 },
        env.SECRET_KEY);
      return json({ token }, 200, { "cache-control": "no-store" });
    }

    const admin = await asAdmin(request, env, ctx, db);
    if (admin instanceof Response) return admin;

    if (url.pathname === "/api/users") {
      if (request.method === "GET") {
        const { results } = await db.prepare("SELECT * FROM users ORDER BY id DESC").all();
        return json(results);
      }
      if (request.method === "POST") {
        const b = await request.json();
        const dup = await db.prepare("SELECT id FROM users WHERE username=?").bind(b.username).first();
        if (dup) return json({ detail: "نام کاربری تکراری" }, 400);
        const expiry = b.expiry_days
          ? new Date(Date.now() + b.expiry_days * 86400_000).toISOString()
          : null;
        const id = crypto.randomUUID();
        const sub = randHex(24);
        await db.prepare(`INSERT INTO users (username, note, uuid, quota_gb, expiry, active, sub_token)
                          VALUES (?,?,?,?,?,1,?)`)
          .bind(b.username, b.note || "", id, b.quota_gb || 0, expiry, sub).run();
        return json({
          username: b.username, uuid: id, sub_token: sub,
          vless: vlessUri({ uuid: id, username: b.username }, url.hostname)
        });
      }
    }

    const uid = url.pathname.split("/")[3];
    if (url.pathname.startsWith("/api/users/") && uid) {
      if (request.method === "PUT") {
        const b = await request.json();
        const sets = [], vals = [];
        if ("active" in b) { sets.push("active=?"); vals.push(b.active ? 1 : 0); }
        if ("note" in b) { sets.push("note=?"); vals.push(b.note); }
        if ("quota_gb" in b) { sets.push("quota_gb=?"); vals.push(b.quota_gb); }
        if ("expiry_days" in b) {
          sets.push("expiry=?");
          vals.push(b.expiry_days ? new Date(Date.now() + b.expiry_days * 86400_000).toISOString() : null);
        }
        if (!sets.length) return json({ detail: "nothing to update" }, 400);
        await db.prepare(`UPDATE users SET ${sets.join(",")} WHERE id=?`).bind(...vals, uid).run();
        return json({ ok: true });
      }
      if (request.method === "DELETE") {
        await db.prepare("DELETE FROM users WHERE id=?").bind(uid).run();
        return json({ ok: true });
      }
    }

    if (url.pathname === "/api/logs") {
      const { results } = await db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 100").all();
      return json(results);
    }

    return json({ detail: "not found" }, 404);
  },
};
