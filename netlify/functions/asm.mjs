// /api/asm — synchro avec Anima Stages Manager (anima.lcdb-dev.eu).
//
//   GET  /api/asm?op=stages                       stages known by the Outil
//   POST /api/asm { op:"preview", planningId, stageId }   cells that differ
//   POST /api/asm { op:"pull",    planningId, stageId }   tasks for "replaceAll"
//   POST /api/asm { op:"push",    planningId, stageId }   writes the Outil
//
// Owner of the planning only (same rule as the "Synchro Anima" button).
// "pull" only converts: the browser then applies the existing replaceAll op,
// which keeps a copy in the history before replacing.
import { requireAuth } from "./_lib/auth.mjs";
import { ensureMigration, getPlanningMeta, getPlanningState } from "./_lib/plannings.mjs";
import { asmConfigured, asmFetch, asmToTasks, diffCells, netlifyToJours } from "./_lib/asm.mjs";

const jsonHeaders = { "Content-Type": "application/json" };
const STAGE_RE = /^[A-Za-z0-9]{6,40}$/;

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...jsonHeaders, ...(init.headers || {}) },
  });
}

async function readStage(stageId) {
  return asmFetch("/stage/" + encodeURIComponent(stageId) + "/planning", { cache: "no-store" });
}

export default async (req) => {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;
  const actor = auth.user;

  if (!asmConfigured()) {
    return json({ error: "Synchro Anima Stages Manager non configurée (ASM_SYNC_TOKEN manquant sur Netlify)." }, { status: 503 });
  }
  await ensureMigration();
  const url = new URL(req.url);

  try {
    if (req.method === "GET" && url.searchParams.get("op") === "stages") {
      const data = await asmFetch("/stages", { cache: "no-store" });
      return json({ stages: data.stages || [] });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

    let body;
    try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }
    const { op, planningId, stageId } = body || {};
    if (!planningId) return json({ error: "Paramètre 'planningId' requis" }, { status: 400 });
    if (!STAGE_RE.test(String(stageId || ""))) return json({ error: "Stage invalide" }, { status: 400 });

    const meta = await getPlanningMeta(planningId);
    if (!meta) return json({ error: "Planning introuvable" }, { status: 404 });
    if (meta.ownerId !== actor.user) return json({ error: "Réservé au propriétaire du planning" }, { status: 403 });

    const [state, asm] = await Promise.all([getPlanningState(planningId), readStage(stageId)]);

    if (op === "preview") {
      return json({ cells: diffCells(state, asm), ignoredDays: netlifyToJours(state, asm).ignoredDays });
    }

    if (op === "pull") {
      return json({ tasks: asmToTasks(state, asm) });
    }

    if (op === "push") {
      const { jours, relinked, ignoredDays } = netlifyToJours(state, asm);
      await asmFetch("/stage/" + encodeURIComponent(stageId) + "/planning", {
        method: "PUT",
        body: JSON.stringify({ jours, rev: asm.rev }),
      });
      return json({ ok: true, relinked: relinked.length, ignoredDays });
    }

    return json({ error: "Opération inconnue" }, { status: 400 });
  } catch (e) {
    const status = e.conflict ? 409 : e.status === 401 ? 502 : e.status && e.status < 500 ? e.status : 502;
    const message = e.status === 401
      ? "Le jeton de synchro a été refusé par Anima Stages Manager (ASM_SYNC_TOKEN)."
      : e.message || "Anima Stages Manager injoignable";
    return json({ error: message, conflict: !!e.conflict }, { status });
  }
};

export const config = { path: "/api/asm" };
