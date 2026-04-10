import { requireAuth } from "./_lib/auth.mjs";
import {
  ensureMigration,
  listPlanningsForUser,
  createPlanning,
  renamePlanning,
  deletePlanning,
  getPlanningMeta,
  userHasAccess,
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

  // All planning routes require authentication.
  const auth = requireAuth(req);
  if (auth.error) return auth.error;
  const actor = auth.user; // { user, role }

  await ensureMigration();

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean); // ["api","plannings", id?]
  const planningId = pathParts[2] ? decodeURIComponent(pathParts[2]) : null;

  try {
    // GET /api/plannings — list accessible plannings
    if (req.method === "GET" && !planningId) {
      const list = await listPlanningsForUser(actor.user);
      return json({ plannings: list });
    }

    // POST /api/plannings — create a new planning (directeurs only).
    // Formateurs can edit content on plannings they're assigned to but
    // cannot create their own.
    if (req.method === "POST" && !planningId) {
      if (actor.role !== "directeur") {
        return json({ error: "Seuls les directeurs peuvent créer un planning" }, { status: 403 });
      }
      let body;
      try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }
      const { name, startDate, dayCount } = body || {};
      const created = await createPlanning({
        name,
        ownerId: actor.user,
        startDate,
        dayCount,
      });
      return json({ planning: created }, { status: 201 });
    }

    // Operations on a specific planning require access.
    if (planningId) {
      const meta = await getPlanningMeta(planningId);
      if (!meta) return json({ error: "Planning introuvable" }, { status: 404 });

      // GET /api/plannings/:id — metadata
      if (req.method === "GET") {
        const hasAccess = await userHasAccess(actor.user, planningId);
        if (!hasAccess) return json({ error: "Permission refusée" }, { status: 403 });
        return json({ planning: meta });
      }

      // PATCH /api/plannings/:id — rename (owner only, enforced in lib)
      if (req.method === "PATCH" || req.method === "PUT") {
        let body;
        try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }
        const updated = await renamePlanning(planningId, body && body.name, actor.user);
        return json({ planning: updated });
      }

      // DELETE /api/plannings/:id — delete (owner only, enforced in lib)
      if (req.method === "DELETE") {
        await deletePlanning(planningId, actor.user);
        return json({ ok: true });
      }
    }
  } catch (e) {
    const message = e && e.message ? e.message : "Erreur interne";
    const status = /permission|refus|propri/i.test(message) ? 403 : 400;
    return json({ error: message }, { status });
  }

  return json({ error: "Not found" }, { status: 404 });
};

export const config = { path: ["/api/plannings", "/api/plannings/:id"] };
