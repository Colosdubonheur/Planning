import {
  requireAuth,
  listUsers,
  createUser,
  deleteUser,
} from "./_lib/auth.mjs";

const jsonHeaders = { "Content-Type": "application/json" };

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...jsonHeaders, ...(init.headers || {}) },
  });
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: jsonHeaders });
  }

  // All /api/users routes require an editor role.
  const auth = requireAuth(req, { role: "editor" });
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean); // ["api", "users", ...]
  const target = pathParts[2]; // may be undefined

  try {
    if (req.method === "GET" && !target) {
      const users = await listUsers();
      return json({ users });
    }

    if (req.method === "POST" && !target) {
      let body;
      try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }
      const created = await createUser(body);
      return json({ user: created }, { status: 201 });
    }

    if (req.method === "DELETE" && target) {
      if (target === auth.user.user) {
        return json({ error: "Impossible de supprimer votre propre compte" }, { status: 400 });
      }
      await deleteUser(decodeURIComponent(target));
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: e.message || "Erreur interne" }, { status: 400 });
  }

  return json({ error: "Not found" }, { status: 404 });
};

export const config = { path: ["/api/users", "/api/users/:user"] };
