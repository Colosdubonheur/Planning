// /api/asm — synchro avec Anima Stages Manager (anima.lcdb-dev.eu).
//
// Connection (once, from the 🗂 window):
//   GET  /api/asm?op=connect&planning=<id>   -> anima.lcdb-dev.eu "Autoriser planning-bafa"
//   GET  /api/asm/pair-callback?code&state   <- back here; the one-time code is exchanged
//                                               for the bridge token server to server
//   GET  /api/asm?op=status                  connected or not, by whom
//   POST /api/asm { op:"disconnect" }        forgets (and revokes) the token
// Sync (owner of the planning, or a directeur who has access to it):
//   GET  /api/asm?op=stages
//   POST /api/asm { op:"preview"|"pull"|"push", planningId, stageId }
// "pull" only converts: the browser then applies the existing replaceAll op,
// which keeps a copy in the history before replacing.
import crypto from "node:crypto";
import { requireAuth } from "./_lib/auth.mjs";
import { ensureMigration, getPlanningMeta, getPlanningState, userHasAccess } from "./_lib/plannings.mjs";
import {
  asmConnection, asmFetch, asmToTasks, bridgeBase, clearAsmConnection, configStore,
  diffCells, netlifyToJours, saveAsmConnection,
} from "./_lib/asm.mjs";

const jsonHeaders = { "Content-Type": "application/json" };
const STAGE_RE = /^[A-Za-z0-9]{6,40}$/;
const PAIR_TTL_MS = 10 * 60 * 1000;

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...jsonHeaders, ...(init.headers || {}) },
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

function backToApp(planningId, params) {
  const q = new URLSearchParams(params);
  if (planningId) q.set("planning", planningId);
  return redirect("/?" + q.toString());
}

async function readStage(stageId) {
  return asmFetch("/stage/" + encodeURIComponent(stageId) + "/planning", { cache: "no-store" });
}

// ── Connection (pairing) ────────────────────────────────────────
async function startPairing(url, actor) {
  const state = crypto.randomBytes(24).toString("base64url");
  const planningId = url.searchParams.get("planning") || "";
  await configStore().setJSON("pair:" + state, { user: actor.user, planningId, exp: Date.now() + PAIR_TTL_MS });
  const ret = url.origin + "/api/asm/pair-callback";
  const pairUrl = bridgeBase().replace(/\/sync$/, "/pair");
  return redirect(pairUrl + "?" + new URLSearchParams({ return: ret, state }).toString());
}

async function finishPairing(url, actor) {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return backToApp("", { asm: "error" });
  const store = configStore();
  const pending = await store.get("pair:" + state, { type: "json" });
  await store.delete("pair:" + state);
  if (!pending || pending.exp < Date.now() || pending.user !== actor.user) {
    return backToApp(pending && pending.planningId, { asm: "error", msg: "Demande expirée, recommence." });
  }
  try {
    const res = await asmFetch("/exchange", {
      method: "POST",
      body: JSON.stringify({ code, state, return: url.origin + "/api/asm/pair-callback" }),
    }, "-");
    if (!res || !res.token) throw new Error("Réponse inattendue de l'outil.");
    await saveAsmConnection({ token: res.token, by: actor.user, at: new Date().toISOString() });
    return backToApp(pending.planningId, { asm: "connected" });
  } catch (e) {
    return backToApp(pending.planningId, { asm: "error", msg: e.message || "Échec de la connexion." });
  }
}

export default async (req) => {
  const auth = requireAuth(req);
  if (auth.error) return auth.error;
  const actor = auth.user;
  await ensureMigration();
  const url = new URL(req.url);
  const op = url.searchParams.get("op");

  try {
    if (url.pathname.endsWith("/pair-callback")) return await finishPairing(url, actor);

    if (req.method === "GET" && op === "connect") return await startPairing(url, actor);

    if (req.method === "GET" && op === "status") {
      const conn = await asmConnection();
      return json({ connected: !!conn, source: conn && conn.source, by: conn && conn.by, at: conn && conn.at });
    }

    if (req.method === "GET" && op === "stages") {
      const data = await asmFetch("/stages", { cache: "no-store" });
      return json({ stages: data.stages || [] });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

    let body;
    try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }

    if (body && body.op === "disconnect") {
      const conn = await asmConnection();
      if (!conn || conn.source !== "app") return json({ error: "Rien à déconnecter ici." }, { status: 400 });
      try { await asmFetch("/revoke", { method: "POST" }, conn.token); } catch {}
      await clearAsmConnection();
      return json({ ok: true });
    }

    const { planningId, stageId } = body || {};
    if (!planningId) return json({ error: "Paramètre 'planningId' requis" }, { status: 400 });
    if (!STAGE_RE.test(String(stageId || ""))) return json({ error: "Stage invalide" }, { status: 400 });

    const meta = await getPlanningMeta(planningId);
    if (!meta) return json({ error: "Planning introuvable" }, { status: 404 });
    const allowed = meta.ownerId === actor.user || (actor.role === "directeur" && await userHasAccess(actor.user, planningId));
    if (!allowed) return json({ error: "Réservé au propriétaire du planning et aux directeurs" }, { status: 403 });

    const [state, asm] = await Promise.all([getPlanningState(planningId), readStage(stageId)]);

    if (body.op === "preview") {
      return json({ cells: diffCells(state, asm), ignoredDays: netlifyToJours(state, asm).ignoredDays });
    }

    if (body.op === "pull") {
      return json({ tasks: asmToTasks(state, asm) });
    }

    if (body.op === "push") {
      const { jours, relinked, ignoredDays } = netlifyToJours(state, asm);
      await asmFetch("/stage/" + encodeURIComponent(stageId) + "/planning", {
        method: "PUT",
        body: JSON.stringify({ jours, rev: asm.rev }),
      });
      return json({ ok: true, relinked: relinked.length, ignoredDays });
    }

    return json({ error: "Opération inconnue" }, { status: 400 });
  } catch (e) {
    if (e.status === 401) {
      return json({ error: "L'outil a refusé la connexion : reconnecte planning-bafa (bouton « Connecter »).", notConnected: true }, { status: 502 });
    }
    if (e.status === 503) return json({ error: e.message, notConnected: true }, { status: 503 });
    const status = e.conflict ? 409 : e.status && e.status < 500 ? e.status : 502;
    return json({ error: e.message || "Anima Stages Manager injoignable", conflict: !!e.conflict }, { status });
  }
};

export const config = { path: ["/api/asm", "/api/asm/pair-callback"] };
