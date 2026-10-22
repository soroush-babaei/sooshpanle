// SooshPanel — آینه اشتراک روی Cloudflare Workers (رایگان)
// مزیت: لینک اشتراک از داخل ایران همیشه در دسترس است، حتی اگر پنل روی IP غیر تمیز باشد.
//
// نصب:
//   1) داشبورد Cloudflare → Workers & Pages → Create Worker
//   2) کد این فایل را Paste کنید
//   3) Settings → Variables → SUB_URL = https://panel.example.com  (آدرس پنل)
//   4) Deploy → آدرس worker را به‌جای SUB_BASE_URL در .env پنل بگذارید
//
// استفاده:  https://sub-worker.your-name.workers.dev/?t=<sub_token>
// یا برای هر کاربر: .../sub/<token>  (همان مسیر پنل)

const UPSTREAM = (globalThis.SUB_URL || "").replace(/\/$/, "");

export default {
  async fetch(request, env) {
    if (!env.SUB_URL) {
      return new Response("SUB_URL variable is not set", { status: 500 });
    }
    const url = new URL(request.url);
    const upstream = new URL(url.pathname + url.search, env.SUB_URL);

    const resp = await fetch(upstream.toString(), {
      headers: {
        "user-agent": request.headers.get("user-agent") || "SooshPanel-Worker",
        "x-forwarded-for": request.headers.get("cf-connecting-ip") || "",
      },
      cf: { cacheTtl: 0 },   // اشتراک همیشه تازه
    });

    const out = new Response(resp.body, resp);
    out.headers.set("access-control-allow-origin", "*");
    out.headers.set("content-type", resp.headers.get("content-type") || "text/plain");
    return out;
  },
};
