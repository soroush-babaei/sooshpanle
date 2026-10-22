var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-8EgAny/checked-fetch.js
var urls = /* @__PURE__ */ new Set();
function checkURL(request, init) {
  const url = request instanceof URL ? request : new URL(
    (typeof request === "string" ? new Request(request, init) : request).url
  );
  if (url.port && url.port !== "443" && url.protocol === "https:") {
    if (!urls.has(url.toString())) {
      urls.add(url.toString());
      console.warn(
        `WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:
 - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.
`
      );
    }
  }
}
__name(checkURL, "checkURL");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    const [request, init] = argArray;
    checkURL(request, init);
    return Reflect.apply(target, thisArg, argArray);
  }
});

// worker.js
import { connect } from "cloudflare:sockets";
var WS_PATH = "/ws";
var SESSION_MIN = 60;
var enc = new TextEncoder();
var dec = new TextDecoder();
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}
__name(json, "json");
var b64 = /* @__PURE__ */ __name((s) => btoa(String.fromCharCode(...enc.encode(s))), "b64");
var hex = /* @__PURE__ */ __name((n) => [...new Uint8Array(n)].map((b) => b.toString(16).padStart(2, "0")).join(""), "hex");
var randHex = /* @__PURE__ */ __name((n) => hex(crypto.getRandomValues(new Uint8Array(n))), "randHex");
async function jwtSign(payload, secret) {
  const data = enc.encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  const b64u = /* @__PURE__ */ __name((a) => btoa(String.fromCharCode(...new Uint8Array(a))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "b64u");
  return `${b64u(data)}.${b64u(sig)}`;
}
__name(jwtSign, "jwtSign");
async function jwtVerify(token, secret) {
  const [p, s] = token.split(".");
  if (!p || !s) return null;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const ok = await crypto.subtle.verify("HMAC", key, sig, enc.encode(p));
  if (!ok) return null;
  const payload = JSON.parse(dec.decode(enc.encode(p.replace(/-/g, "+").replace(/_/g, "/"))));
  if (payload.exp < Date.now()) return null;
  return payload;
}
__name(jwtVerify, "jwtVerify");
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
    )`)
  ]);
}
__name(ensureSchema, "ensureSchema");
async function log(db, ip, user, action, ok = 1) {
  try {
    await db.prepare("INSERT INTO logs (ip, user, action, ok) VALUES (?,?,?,?)").bind(ip, user, action, ok).run();
  } catch {
  }
}
__name(log, "log");
async function getUserByToken(db, token) {
  return db.prepare("SELECT * FROM users WHERE sub_token=?").bind(token).first();
}
__name(getUserByToken, "getUserByToken");
async function getUserByUuid(db, uuid) {
  return db.prepare("SELECT * FROM users WHERE uuid=?").bind(uuid).first();
}
__name(getUserByUuid, "getUserByUuid");
function userAllowed(u) {
  if (!u || !u.active) return false;
  if (u.expiry && u.expiry < (/* @__PURE__ */ new Date()).toISOString()) return false;
  return true;
}
__name(userAllowed, "userAllowed");
async function touchUser(db, id) {
  try {
    await db.prepare("UPDATE users SET last_seen=datetime('now') WHERE id=?").bind(id).run();
  } catch {
  }
}
__name(touchUser, "touchUser");
async function handleVless(request, env, db) {
  const [client, upstream] = Object.values(new WebSocketPair());
  upstream.accept();
  let remote = null, remoteWriter = null, headerDone = false, userId = null;
  upstream.addEventListener("message", async (ev) => {
    if (remote) return;
    let data;
    if (ev.data instanceof ArrayBuffer) data = new Uint8Array(ev.data);
    else if (typeof ev.data === "string") data = enc.encode(ev.data);
    else return;
    try {
      if (data[0] !== 0) throw new Error("bad vless version");
      const uuid = hex(data.slice(1, 17));
      const user = await getUserByUuid(db, uuid);
      if (!userAllowed(user)) {
        upstream.close(1008, "unauthorized");
        return;
      }
      userId = user.id;
      touchUser(db, userId);
      let i = 17;
      const optLen = data[i];
      i += 1;
      i += optLen;
      const command = data[i];
      i += 1;
      const port = data[i] << 8 | data[i + 1];
      i += 2;
      const atype = data[i];
      i += 1;
      let host;
      if (atype === 1) {
        host = [...data.slice(i, i + 4)].join(".");
        i += 4;
      } else if (atype === 2) {
        const len = data[i];
        i += 1;
        host = dec.decode(data.slice(i, i + len));
        i += len;
      } else if (atype === 3) {
        const p = [];
        for (let j = 0; j < 8; j++) p.push(data[i + j * 2].toString(16) + data[i + j * 2 + 1].toString(16));
        host = p.join(":");
        i += 16;
      } else throw new Error("bad atype");
      if (command === 2) {
        upstream.close(1008, "udp not supported");
        return;
      }
      const resp = new Uint8Array([0, 0]);
      upstream.send(resp.buffer);
      remote = connect({ hostname: host, port });
      remoteWriter = remote.writable.getWriter();
      await remoteWriter.write(data.slice(i));
      remote.readable.pipeTo(new WritableStream({
        write: /* @__PURE__ */ __name((chunk) => upstream.send(chunk), "write"),
        close: /* @__PURE__ */ __name(() => upstream.close(1e3), "close")
      })).catch(() => upstream.close(1e3));
      headerDone = true;
      const reader = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(data.slice(i));
        }
      }).getReader();
      upstream.addEventListener("message", async (ev2) => {
        if (!remote) return;
        const d = ev2.data instanceof ArrayBuffer ? new Uint8Array(ev2.data) : enc.encode(ev2.data);
        try {
          await remoteWriter.write(d);
        } catch {
        }
      });
    } catch (e) {
      try {
        upstream.close(1011, String(e));
      } catch {
      }
    }
  });
  upstream.addEventListener("close", () => {
    try {
      remote?.close();
    } catch {
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}
__name(handleVless, "handleVless");
function vlessUri(u, host) {
  const p = new URLSearchParams({
    type: "ws",
    security: "tls",
    encryption: "none",
    fp: "chrome",
    host,
    path: WS_PATH,
    sni: host
  });
  return `vless://${u.uuid}@${host}:443?${p}#${encodeURIComponent(u.username + "|SooshPanel-CF")}`;
}
__name(vlessUri, "vlessUri");
async function requireAdmin(request, env) {
  const t = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  const p = await jwtVerify(t, env.SECRET_KEY || "soosh-default-secret-change-me");
  if (!p || p.role !== "admin") throw new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401 });
  return p;
}
__name(requireAdmin, "requireAdmin");
var catchAuth = /* @__PURE__ */ __name((fn) => async (request, env, ctx, db) => {
  try {
    return await fn(request, env, db);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}, "catchAuth");
var asAdmin = /* @__PURE__ */ __name(async (request, env, ctx, db) => {
  const admin = await catchAuth(requireAdmin)(request, env, ctx, db);
  if (admin instanceof Response) return admin;
  return admin;
}, "asAdmin");
var UI = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
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
<div id="loginBox" class="card"><h2>\u0648\u0631\u0648\u062F \u0627\u062F\u0645\u06CC\u0646</h2>
<input id="u" placeholder="\u0646\u0627\u0645 \u06A9\u0627\u0631\u0628\u0631\u06CC"><input id="p" type="password" placeholder="\u0631\u0645\u0632">
<button onclick="login()">\u0648\u0631\u0648\u062F</button></div>
<div id="panel" style="display:none">
<div class="card" style="display:flex;justify-content:space-between;align-items:center">
<h1>\u2601\uFE0F SooshPanel (Cloudflare)</h1><div>
<button onclick="viewLogs()">\u0644\u0627\u06AF</button><button class="danger" onclick="logout()">\u062E\u0631\u0648\u062C</button></div></div>
<div class="card"><h2>\u0627\u0641\u0632\u0648\u062F\u0646 \u06A9\u0627\u0631\u0628\u0631</h2><div class="grid">
<input id="f_user" placeholder="\u0646\u0627\u0645 \u06A9\u0627\u0631\u0628\u0631\u06CC"><input id="f_limit" type="number" placeholder="\u062D\u062C\u0645 (GB) - \u0646\u0645\u0627\u06CC\u0634\u06CC">
<input id="f_exp" type="number" placeholder="\u0627\u0646\u0642\u0636\u0627 (\u0631\u0648\u0632\u060C 0=\u0646\u062F\u0627\u0631\u062F)"><input id="f_note" placeholder="\u06CC\u0627\u062F\u062F\u0627\u0634\u062A"></div>
<button onclick="addUser()">\u0627\u06CC\u062C\u0627\u062F</button></div>
<div class="card"><h2>\u06A9\u0627\u0631\u0628\u0631\u0627\u0646</h2><div style="overflow-x:auto"><table id="tbl">
<thead><tr><th>\u06A9\u0627\u0631\u0628\u0631</th><th>\u0648\u0636\u0639\u06CC\u062A</th><th>\u0627\u0646\u0642\u0636\u0627</th><th>\u0644\u06CC\u0646\u06A9 \u06A9\u0627\u0646\u0641\u06CC\u06AF</th><th>\u0627\u0642\u062F\u0627\u0645</th></tr></thead><tbody></tbody></table></div>
<div class="muted">\u0644\u06CC\u0646\u06A9 \u06A9\u0627\u0646\u0641\u06CC\u06AF \u0631\u0627 \u06A9\u067E\u06CC \u0648 \u062F\u0631 v2rayNG/Hiddify import \u06A9\u0646\u06CC\u062F.</div></div>
<div id="logsBox" class="card" style="display:none"><h2>\u0644\u0627\u06AF</h2><table id="logtbl">
<thead><tr><th>\u0632\u0645\u0627\u0646</th><th>IP</th><th>\u06A9\u0627\u0631\u0628\u0631</th><th>\u0627\u0642\u062F\u0627\u0645</th><th>\u0646\u062A\u06CC\u062C\u0647</th></tr></thead><tbody></tbody></table></div>
</div>
<script>
let token=localStorage.getItem("t")||"";
const H=()=>({"Authorization":"Bearer "+token,"Content-Type":"application/json"});
async function login(){
 const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({username:u.value,password:p.value})});
 if(!r.ok){alert("\u0648\u0631\u0648\u062F \u0646\u0627\u0645\u0648\u0641\u0642");return}
 token=(await r.json()).token;localStorage.setItem("t",token);boot();
}
function logout(){localStorage.removeItem("t");location.reload()}
function boot(){loginBox.style.display="none";panel.style.display="block";refresh()}
async function refresh(){
 const [users,host]=await Promise.all([fetch("/api/users",{headers:H()}).then(r=>r.json()),
   Promise.resolve(location.hostname)]);
 const tb=tbl.querySelector("tbody");tb.innerHTML="";
 users.forEach(u=>{
  const st=!u.active?"\u26D4 \u063A\u06CC\u0631\u0641\u0639\u0627\u0644":(u.expiry&&u.expiry<new Date().toISOString()?"\u23F0 \u0645\u0646\u0642\u0636\u06CC":"\u{1F7E2} \u0641\u0639\u0627\u0644");
  tb.innerHTML+=\`<tr><td><b>\${u.username}</b><div class="muted">\${u.note||""}</div></td>
   <td class="\${u.active?'ok':'bad'}">\${st}</td><td>\${u.expiry?u.expiry.slice(0,10):"\u2014"}</td>
   <td><a href="#" onclick="copyLink('\${u.uuid}');return false">\u06A9\u067E\u06CC \u0644\u06CC\u0646\u06A9</a>
       <div class="muted">/sub/\${u.sub_token.slice(0,8)}\u2026</div></td>
   <td><button class="danger" onclick="del(\${u.id})">\u062D\u0630\u0641</button>
       <button onclick="toggle(\${u.id},\${u.active})">\${u.active?'\u0642\u0637\u0639':'\u0648\u0635\u0644'}</button></td></tr>\`;
 });
}
function copyLink(uuid){navigator.clipboard.writeText(
  \`vless://\${uuid}@\${location.hostname}:443?type=ws&security=tls&encryption=none&fp=chrome&host=\${location.hostname}&path=/ws&sni=\${location.hostname}#soosh\`);
 alert("\u0644\u06CC\u0646\u06A9 \u06A9\u067E\u06CC \u0634\u062F \u2014 \u062F\u0631 v2rayNG: Import from clipboard")}
async function addUser(){
 const r=await fetch("/api/users",{method:"POST",headers:H(),
  body:JSON.stringify({username:f_user.value,quota_gb:+f_limit.value||0,
   expiry_days:+f_exp.value||0,note:f_note.value})});
 if(!r.ok){alert((await r.json()).detail||"\u062E\u0637\u0627");return} f_user.value="";refresh()}
async function del(id){if(!confirm("\u062D\u0630\u0641 \u0634\u0648\u062F\u061F"))return;
 await fetch("/api/users/"+id,{method:"DELETE",headers:H()});refresh()}
async function toggle(id,active){
 await fetch("/api/users/"+id,{method:"PUT",headers:H(),body:JSON.stringify({active:!active})});refresh()}
async function viewLogs(){
 const logs=await fetch("/api/logs",{headers:H()}).then(r=>r.json());
 logsBox.style.display="block";
 logtbl.querySelector("tbody").innerHTML=logs.map(l=>
  \`<tr><td>\${l.ts}</td><td>\${l.ip}</td><td>\${l.user}</td><td>\${l.action}</td>
   <td class="\${l.ok?'ok':'bad'}">\${l.ok?'\u2714':'\u2718'}</td></tr>\`).join("")}
if(token)boot();
<\/script></body></html>`;
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const db = env.DB;
    const ip = request.headers.get("cf-connecting-ip") || "?";
    if (url.pathname === WS_PATH) {
      if (request.headers.get("Upgrade") !== "websocket") return json({ detail: "websocket only" }, 400);
      return handleVless(request, env, db);
    }
    if (url.pathname.startsWith("/sub/")) {
      const token = url.pathname.split("/")[2];
      const u = await getUserByToken(db, token);
      if (!u || !userAllowed(u)) return new Response("invalid", { status: 404 });
      const body = b64(vlessUri(u, url.hostname) + "\n");
      return new Response(body, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "subscription-userinfo": `upload=0; download=0; total=${Math.round((u.quota_gb || 0) * 1e9)}; expire=${u.expiry ? Math.floor(new Date(u.expiry).getTime() / 1e3) : 0}`,
          "profile-update-interval": "6"
        }
      });
    }
    if (url.pathname === "/") return new Response(UI, { headers: { "content-type": "text/html; charset=utf-8" } });
    await ensureSchema(db);
    if (url.pathname === "/api/login" && request.method === "POST") {
      const { username, password } = await request.json();
      const okU = username === (env.ADMIN_USERNAME || "admin");
      const okP = password === (env.ADMIN_PASSWORD || "");
      await log(db, ip, username || "?", "login", okU && okP ? 1 : 0);
      if (!okU || !okP) return json({ detail: "\u0646\u0627\u0645 \u06A9\u0627\u0631\u0628\u0631\u06CC \u06CC\u0627 \u0631\u0645\u0632 \u0627\u0634\u062A\u0628\u0627\u0647" }, 401);
      const token = await jwtSign(
        { role: "admin", exp: Date.now() + SESSION_MIN * 6e4 },
        env.SECRET_KEY || "soosh-default-secret-change-me"
      );
      return json({ token });
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
        if (dup) return json({ detail: "\u0646\u0627\u0645 \u06A9\u0627\u0631\u0628\u0631\u06CC \u062A\u06A9\u0631\u0627\u0631\u06CC" }, 400);
        const expiry = b.expiry_days ? new Date(Date.now() + b.expiry_days * 864e5).toISOString() : null;
        const id = crypto.randomUUID();
        const sub = randHex(24);
        await db.prepare(`INSERT INTO users (username, note, uuid, quota_gb, expiry, active, sub_token)
                          VALUES (?,?,?,?,?,1,?)`).bind(b.username, b.note || "", id, b.quota_gb || 0, expiry, sub).run();
        return json({
          username: b.username,
          uuid: id,
          sub_token: sub,
          vless: vlessUri({ uuid: id, username: b.username }, url.hostname)
        });
      }
    }
    const uid = url.pathname.split("/")[3];
    if (url.pathname.startsWith("/api/users/") && uid) {
      if (request.method === "PUT") {
        const b = await request.json();
        const sets = [], vals = [];
        if ("active" in b) {
          sets.push("active=?");
          vals.push(b.active ? 1 : 0);
        }
        if ("note" in b) {
          sets.push("note=?");
          vals.push(b.note);
        }
        if ("quota_gb" in b) {
          sets.push("quota_gb=?");
          vals.push(b.quota_gb);
        }
        if ("expiry_days" in b) {
          sets.push("expiry=?");
          vals.push(b.expiry_days ? new Date(Date.now() + b.expiry_days * 864e5).toISOString() : null);
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
  }
};

// C:/Users/sorou/AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/sorou/AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-8EgAny/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// C:/Users/sorou/AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-8EgAny/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
