// /api/doc?url=<document url>
//
// Lets the planning show an Anima resource (PDF, image, video) inside the
// app.  The documents are hosted by Anima's platform and its S3 bucket,
// which do not allow other sites to read them from the browser, so the app
// fetches them through this function.
//
// Only logged-in team members may use it, and only for Anima's hosts, so it
// cannot be used as an open proxy.
import { requireAuth } from "./_lib/auth.mjs";

const ALLOWED = [
  { host: "plateforme.anima-lorraine.fr", path: /^\/dl\// },
  { host: "www.anima-lorraine.fr", path: /^\/dl\// },
  { host: "s3-eu-west-1.amazonaws.com", path: /^\/ophibox-proto\// },
];
const MAX_BYTES = 20 * 1024 * 1024;
const TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|video\/mp4)$/;

export function isAllowedDocUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  return ALLOWED.some((a) => a.host === u.hostname && a.path.test(u.pathname));
}

function typeFromName(pathname) {
  const ext = (pathname.split(".").pop() || "").toLowerCase();
  return {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", mp4: "video/mp4",
  }[ext] || "";
}

export default async (req) => {
  const text = (msg, status) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (req.method !== "GET") return text("Méthode non autorisée", 405);
  const auth = requireAuth(req);
  if (auth.error) return auth.error;

  const raw = new URL(req.url).searchParams.get("url") || "";
  if (!isAllowedDocUrl(raw)) return text("Document non autorisé", 400);

  let upstream;
  try {
    upstream = await fetch(raw, { redirect: "follow", headers: { Accept: "*/*" } });
  } catch {
    return text("Document injoignable", 502);
  }
  // A redirect must not lead outside the allowed hosts.
  if (upstream.url && !isAllowedDocUrl(upstream.url)) return text("Redirection non autorisée", 502);
  if (!upstream.ok) return text("Document introuvable", upstream.status === 404 ? 404 : 502);

  const len = Number(upstream.headers.get("content-length") || 0);
  if (len > MAX_BYTES) return text("Document trop volumineux pour l'aperçu", 413);

  let type = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!TYPES.test(type)) type = typeFromName(new URL(raw).pathname);
  if (!TYPES.test(type)) return text("Type de document non pris en charge", 415);

  const headers = {
    "Content-Type": type,
    "Content-Disposition": "inline",
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  };
  if (len) headers["Content-Length"] = String(len);
  return new Response(upstream.body, { status: 200, headers });
};

export const config = { path: "/api/doc" };
