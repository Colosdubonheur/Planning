import {
  authenticate,
  signToken,
  buildAuthCookie,
  buildClearCookie,
  requireAuth,
  getUser,
} from "./_lib/auth.mjs";

const jsonHeaders = { "Content-Type": "application/json" };

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...jsonHeaders, ...(init.headers || {}) },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: jsonHeaders });
  }

  // POST /api/auth/login
  if (path.endsWith("/login") && req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }
    const { user, password } = body || {};
    if (!user || !password) return json({ error: "Identifiant ou mot de passe manquant" }, { status: 400 });
    try {
      const auth = await authenticate(user, password);
      if (!auth) return json({ error: "Identifiant ou mot de passe incorrect" }, { status: 401 });
      const token = signToken({ user: auth.user, role: auth.role });
      // Expose isMaster so the UI can gate role-editing controls immediately
      // after login, without waiting for the next /api/auth/me poll.
      let isMaster = false;
      try {
        const rec = await getUser(auth.user);
        isMaster = !!(rec && rec.parent === null);
      } catch {}
      return new Response(
        JSON.stringify({ user: auth.user, role: auth.role, isMaster }),
        { status: 200, headers: { ...jsonHeaders, "Set-Cookie": buildAuthCookie(token) } }
      );
    } catch (e) {
      return json({ error: e.message || "Erreur interne" }, { status: 500 });
    }
  }

  // POST /api/auth/logout
  if (path.endsWith("/logout") && req.method === "POST") {
    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { ...jsonHeaders, "Set-Cookie": buildClearCookie() } }
    );
  }

  // GET /api/auth/me
  if (path.endsWith("/me") && req.method === "GET") {
    const auth = requireAuth(req);
    if (auth.error) return auth.error;
    // Include isMaster (root user with parent === null) so the UI can show
    // the right controls: only the master can modify users or create other
    // directeurs.
    let isMaster = false;
    try {
      const rec = await getUser(auth.user.user);
      isMaster = !!(rec && rec.parent === null);
    } catch {}
    return json({ user: auth.user.user, role: auth.user.role, isMaster });
  }

  return json({ error: "Not found" }, { status: 404 });
};

export const config = { path: ["/api/auth/login", "/api/auth/logout", "/api/auth/me"] };
