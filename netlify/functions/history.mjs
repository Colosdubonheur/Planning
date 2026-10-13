// /api/history: version history of a planning (planning-bafa and Anima
// copies).
//
//   GET  /api/history?planning=<id>          list (newest first, no content)
//   GET  /api/history?planning=<id>&id=<sid> one snapshot with its content
//   POST /api/history?planning=<id>          { source, label, data }
//
// Owner of the planning only (cookie session or the planning's sync token).
import { requireAuth } from "./_lib/auth.mjs";
import { ensureMigration, getPlanningMeta, userHasAccess } from "./_lib/plannings.mjs";
import { listSnapshots, getSnapshot, addSnapshot } from "./_lib/history.mjs";
import { corsFor, withCors } from "./_lib/cors.mjs";

export default async (req) => {
  const cors = corsFor(req);
  const json = (body, init = {}) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { "Content-Type": "application/json", ...cors, ...(init.headers || {}) },
    });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const auth = requireAuth(req, { allowSync: true });
  if (auth.error) return withCors(auth.error, cors);
  const actor = auth.user;

  await ensureMigration();
  const url = new URL(req.url);
  const planningId = url.searchParams.get("planning");
  if (!planningId) return json({ error: "Paramètre 'planning' requis" }, { status: 400 });
  if (actor.scope === "sync" && actor.planningId !== planningId) {
    return json({ error: "Jeton de synchro invalide pour ce planning" }, { status: 403 });
  }
  const meta = await getPlanningMeta(planningId);
  if (!meta) return json({ error: "Planning introuvable" }, { status: 404 });
  if (meta.ownerId !== actor.user || !(await userHasAccess(actor.user, planningId))) {
    return json({ error: "Historique réservé au propriétaire du planning" }, { status: 403 });
  }

  try {
    if (req.method === "GET") {
      const snapId = url.searchParams.get("id");
      if (snapId) {
        const snap = await getSnapshot(planningId, snapId);
        if (!snap) return json({ error: "Version introuvable" }, { status: 404 });
        return json({ snapshot: snap });
      }
      return json({ versions: await listSnapshots(planningId) });
    }

    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }
      const created = await addSnapshot(planningId, {
        source: body && body.source,
        label: body && body.label,
        by: actor.user,
        data: body && body.data,
      });
      return json({ version: created }, { status: 201 });
    }
  } catch (e) {
    return json({ error: e.message || "Erreur interne" }, { status: 400 });
  }

  return json({ error: "Method not allowed" }, { status: 405 });
};

export const config = { path: "/api/history" };
