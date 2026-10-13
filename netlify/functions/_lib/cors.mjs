// CORS for the "Synchro Anima" bookmarklet, which runs on the Anima
// platform and calls our API cross-origin with a Bearer sync token (no
// cookies, so no Access-Control-Allow-Credentials).
const CORS_ORIGINS = new Set(["https://plateforme.anima-lorraine.fr"]);

export function corsFor(req) {
  const origin = req.headers.get("origin");
  if (!origin || !CORS_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function withCors(res, cors) {
  for (const [k, v] of Object.entries(cors || {})) res.headers.set(k, v);
  return res;
}
