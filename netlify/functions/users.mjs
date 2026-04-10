import {
  requireAuth,
  listUsersFor,
  createUser,
  deleteUserCascade,
  grantPlanningAccess,
  revokePlanningAccess,
  getUser,
} from "./_lib/auth.mjs";
import {
  ensureMigration,
  userHasAccess,
  getPlanningMeta,
} from "./_lib/plannings.mjs";

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

  // All /api/users routes require the directeur role.  Formateurs can edit
  // content on plannings they're assigned to but cannot create sub-users.
  const auth = requireAuth(req, { role: "directeur" });
  if (auth.error) return auth.error;
  const actor = auth.user; // { user, role }

  await ensureMigration();

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean); // ["api","users",...]
  const target = pathParts[2] ? decodeURIComponent(pathParts[2]) : null;
  // Optional sub-resource: /api/users/:user/plannings/:planningId
  const subResource = pathParts[3] || null;
  const subTarget = pathParts[4] ? decodeURIComponent(pathParts[4]) : null;

  try {
    // GET /api/users — list self + descendants
    if (req.method === "GET" && !target) {
      const users = await listUsersFor(actor.user);
      return json({ users });
    }

    // POST /api/users — create a sub-user (child of current user)
    if (req.method === "POST" && !target) {
      let body;
      try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }
      const { user, password, role } = body || {};
      let plannings = Array.isArray(body && body.plannings) ? body.plannings : [];

      // If a single planningId is provided (current UI shortcut), use that.
      if (!plannings.length && body && typeof body.planningId === "string" && body.planningId) {
        plannings = [body.planningId];
      }

      // Every requested planning must be accessible to the creator.
      for (const pid of plannings) {
        const hasAccess = await userHasAccess(actor.user, pid);
        if (!hasAccess) {
          return json({ error: "Planning inaccessible: " + pid }, { status: 403 });
        }
      }

      const created = await createUser({
        user,
        password,
        role,
        parent: actor.user,
        plannings,
      });
      return json({ user: created }, { status: 201 });
    }

    // DELETE /api/users/:user — delete a sub-user (and their subtree)
    if (req.method === "DELETE" && target && !subResource) {
      if (target === actor.user) {
        return json({ error: "Impossible de supprimer votre propre compte" }, { status: 400 });
      }
      // Ensure the target is within the caller's subtree.
      const visible = await listUsersFor(actor.user);
      if (!visible.some((u) => u.user === target)) {
        return json({ error: "Utilisateur hors de votre sous-arbre" }, { status: 403 });
      }
      const removed = await deleteUserCascade(target);
      return json({ ok: true, removed });
    }

    // POST /api/users/:user/plannings — grant planning access
    if (req.method === "POST" && target && subResource === "plannings") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }
      const { planningId } = body || {};
      if (!planningId) return json({ error: "planningId requis" }, { status: 400 });
      const meta = await getPlanningMeta(planningId);
      if (!meta) return json({ error: "Planning introuvable" }, { status: 404 });
      const next = await grantPlanningAccess(target, planningId, actor.user);
      const updated = await getUser(target);
      return json({ user: updated, plannings: next });
    }

    // DELETE /api/users/:user/plannings/:planningId — revoke access
    if (req.method === "DELETE" && target && subResource === "plannings" && subTarget) {
      const next = await revokePlanningAccess(target, subTarget, actor.user);
      const updated = await getUser(target);
      return json({ user: updated, plannings: next });
    }
  } catch (e) {
    const message = e && e.message ? e.message : "Erreur interne";
    const status = /permission|refus|sous-arbre|non accessible|pas accès/i.test(message) ? 403 : 400;
    return json({ error: message }, { status });
  }

  return json({ error: "Not found" }, { status: 404 });
};

export const config = {
  path: [
    "/api/users",
    "/api/users/:user",
    "/api/users/:user/plannings",
    "/api/users/:user/plannings/:planningId",
  ],
};
