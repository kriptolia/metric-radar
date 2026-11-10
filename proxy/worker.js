/**
 * Optional Cloudflare Worker: CORS proxy for Metric's public API.
 * Only needed if browsers can't call api.metric.xyz directly (CORS error in the console).
 *
 * Deploy: create a Worker, paste this file, note its URL (e.g. https://metric-proxy.<you>.workers.dev),
 * then in Metric Radar → Settings → API base enter `https://metric-proxy.<you>.workers.dev/public/v1`.
 * Set ALLOWED_ORIGIN to your Pages origin to keep the proxy private to your site.
 */
const UPSTREAM = "https://api.metric.xyz";
const ALLOWED_ORIGIN = "*"; // e.g. "https://kriptolia.github.io"

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/public/v1/")) return new Response("not found", { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (request.method !== "GET" && request.method !== "POST") return new Response("method not allowed", { status: 405, headers: cors() });
    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method,
      headers: { Accept: "application/json", "Content-Type": request.headers.get("Content-Type") || "application/json" },
      body: request.method === "POST" ? await request.text() : undefined,
      cf: { cacheTtl: 20, cacheEverything: request.method === "GET" },
    });
    const headers = new Headers(cors());
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    headers.set("Cache-Control", "public, max-age=20");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}
