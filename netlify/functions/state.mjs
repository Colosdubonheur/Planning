import { requireAuth } from "./_lib/auth.mjs";
import {
  ensureMigration,
  getPlanningState,
  getPlanningMeta,
  updatePlanningState,
  listPlanningsForUser,
  userHasAccess,
} from "./_lib/plannings.mjs";
import { buildDaysFromStart } from "./_lib/seed.mjs";
import { corsFor, withCors } from "./_lib/cors.mjs";
import { addSnapshot, netlifySnapshotData } from "./_lib/history.mjs";

const jsonHeaders = { "Content-Type": "application/json" };

let corsHeaders = {}; // set per request (functions handle one request at a time)

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...jsonHeaders, ...corsHeaders, ...(init.headers || {}) },
  });
}

const MAX_TEXT = 300;
const MAX_ANIMA_ID = 300;

function cleanText(raw) {
  if (typeof raw !== "string") throw new Error("Texte manquant");
  const text = raw.trim();
  if (!text) throw new Error("Le texte ne peut pas être vide");
  if (text.length > MAX_TEXT) throw new Error(`Texte trop long (${MAX_TEXT} caractères max)`);
  return text;
}

// ── Task details ("fiche" of a module) ─────────────────────────
// Prepared collaboratively by the team.  Only `resume` (text meant for the
// trainees) is visible on the public share link; everything else is
// team-only and stripped from anonymous reads.
const DETAIL_TEXT_FIELDS = {
  resume: 2000,     // pour les stagiaires (public)
  duree: 60,
  objectifs: 4000,
  deroule: 8000,
  materiel: 4000,
  notes: 4000,      // notes internes de l'équipe
  ficheAnima: 6000, // sommaire de la fiche Anima (renseigné par la synchro)
};
const DETAIL_STATUS = new Set(["", "a_preparer", "en_cours", "pret"]);
const PUBLIC_DETAIL_FIELDS = new Set(["resume", "duree", "formateurs"]);

function cleanDetailsPatch(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Détails manquants");
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k in DETAIL_TEXT_FIELDS) {
      if (typeof v !== "string") throw new Error(`Champ ${k} invalide`);
      if (v.length > DETAIL_TEXT_FIELDS[k]) throw new Error(`Champ ${k} trop long`);
      out[k] = v.replace(/\r\n/g, "\n");
    } else if (k === "statut") {
      if (!DETAIL_STATUS.has(v)) throw new Error("Statut invalide");
      out.statut = v;
    } else if (k === "formateurs") {
      if (!Array.isArray(v) || v.length > 10) throw new Error("Formateurs invalides");
      out.formateurs = v.map((x) => String(x).trim().slice(0, 60)).filter(Boolean);
    } else {
      throw new Error(`Champ inconnu: ${k}`);
    }
  }
  return out;
}

function applyDetailsPatch(task, patch, actorUser) {
  const details = { ...(task.details || {}) };
  for (const [k, v] of Object.entries(patch)) {
    const empty = v === "" || (Array.isArray(v) && !v.length);
    if (empty) delete details[k]; else details[k] = v;
  }
  details.updatedBy = actorUser;
  details.updatedAt = Date.now();
  task.details = details;
}

// Anonymous viewers (share link) only see the public part of the details.
export function publicView(state) {
  return {
    ...state,
    tasks: (state.tasks || []).map((t) => {
      if (!t.details) return t;
      const d = {};
      for (const k of PUBLIC_DETAIL_FIELDS) if (t.details[k] !== undefined) d[k] = t.details[k];
      const { details, ...rest } = t;
      return Object.keys(d).length ? { ...rest, details: d } : rest;
    }),
  };
}

function cleanAnimaId(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > MAX_ANIMA_ID) throw new Error("animaId invalide");
  return raw;
}

function newTaskId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function reorderColumn(state, dayId, slotId) {
  const column = state.tasks
    .filter((t) => t.dayId === dayId && t.slotId === slotId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  column.forEach((t, i) => { t.order = i; });
}

function applyOp(state, op, actor) {
  if (!op || typeof op !== "object" || !op.op) {
    throw new Error("Opération manquante");
  }

  // Permission model:
  //   - Anyone with planning access can tick tasks and edit their content
  //     (add/edit/remove/reorder/move) — this lets formateurs do their job.
  //   - Structural / destructive ops (reset, setSchedule) are reserved to
  //     the planning owner; only directeurs can ever be owners.
  //   - Rename / delete are handled in plannings.mjs (also owner-only).
  const requireOwner = () => {
    if (!actor.isOwner) throw new Error("Permission refusée (propriétaire requis)");
  };

  switch (op.op) {
    case "toggle": {
      const task = state.tasks.find((t) => t.id === op.taskId);
      if (!task) throw new Error("Tâche introuvable");
      task.done = !!op.done;
      break;
    }

    case "setDetails": {
      const task = state.tasks.find((t) => t.id === op.taskId);
      if (!task) throw new Error("Tâche introuvable");
      applyDetailsPatch(task, cleanDetailsPatch(op.details), actor.user);
      break;
    }

    case "edit": {
      const task = state.tasks.find((t) => t.id === op.taskId);
      if (!task) throw new Error("Tâche introuvable");
      task.text = cleanText(op.text);
      break;
    }

    case "add": {
      const { dayId, slotId } = op;
      if (!state.days.some((d) => d.id === dayId)) throw new Error("Jour invalide");
      if (!state.slots.some((s) => s.id === slotId)) throw new Error("Créneau invalide");
      if (slotId === "repas") throw new Error("Le créneau Repas n'est pas éditable");
      const text = cleanText(op.text || "");
      const animaId = cleanAnimaId(op.animaId);
      const existing = state.tasks.filter((t) => t.dayId === dayId && t.slotId === slotId);
      const order = existing.length;
      const task = { id: newTaskId(), dayId, slotId, order, text, done: false };
      if (animaId) task.animaId = animaId;
      state.tasks.push(task);
      break;
    }

    case "remove": {
      const idx = state.tasks.findIndex((t) => t.id === op.taskId);
      if (idx === -1) throw new Error("Tâche introuvable");
      const removed = state.tasks[idx];
      state.tasks.splice(idx, 1);
      reorderColumn(state, removed.dayId, removed.slotId);
      break;
    }

    case "reorder": {
      const task = state.tasks.find((t) => t.id === op.taskId);
      if (!task) throw new Error("Tâche introuvable");
      if (op.direction !== "up" && op.direction !== "down") {
        throw new Error("Direction invalide");
      }
      const column = state.tasks
        .filter((t) => t.dayId === task.dayId && t.slotId === task.slotId)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const idx = column.findIndex((t) => t.id === task.id);
      const newIdx = op.direction === "up" ? idx - 1 : idx + 1;
      if (newIdx < 0 || newIdx >= column.length) {
        break;
      }
      [column[idx], column[newIdx]] = [column[newIdx], column[idx]];
      column.forEach((t, i) => { t.order = i; });
      break;
    }

    case "move": {
      const task = state.tasks.find((t) => t.id === op.taskId);
      if (!task) throw new Error("Tâche introuvable");
      if (!state.days.some((d) => d.id === op.dayId)) throw new Error("Jour invalide");
      if (!state.slots.some((s) => s.id === op.slotId)) throw new Error("Créneau invalide");
      if (op.slotId === "repas") throw new Error("Le créneau Repas n'est pas éditable");
      const oldDayId = task.dayId;
      const oldSlotId = task.slotId;
      task.dayId = op.dayId;
      task.slotId = op.slotId;
      // Destination column without the moved task, in display order.
      const dest = state.tasks
        .filter((t) => t.dayId === op.dayId && t.slotId === op.slotId && t.id !== task.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      // Optional insertion index (drag & drop); default: end of column.
      let index = Number.isInteger(op.index) ? op.index : dest.length;
      index = Math.max(0, Math.min(dest.length, index));
      dest.splice(index, 0, task);
      dest.forEach((t, i) => { t.order = i; });
      if (oldDayId !== op.dayId || oldSlotId !== op.slotId) {
        reorderColumn(state, oldDayId, oldSlotId);
      }
      break;
    }

    // Replace the whole content of the planning in one go (used by the
    // Anima synchronisation).  `op.tasks` is the full desired list, in
    // display order: [{ dayId, slotId, text, animaId? }].  Existing tasks
    // are matched (by animaId first, then by text within the same cell,
    // then by text anywhere) so their id and "done" state survive.
    case "replaceAll": {
      requireOwner();
      if (!Array.isArray(op.tasks)) throw new Error("Liste de tâches manquante");
      if (op.tasks.length > 1000) throw new Error("Trop de tâches");
      const dayIds = new Set(state.days.map((d) => d.id));
      const slotIds = new Set(state.slots.map((s) => s.id));
      const pool = state.tasks.slice();
      const take = (pred) => {
        const i = pool.findIndex(pred);
        return i === -1 ? null : pool.splice(i, 1)[0];
      };
      const next = [];
      const counters = {};
      for (const raw of op.tasks) {
        if (!raw || typeof raw !== "object") throw new Error("Tâche invalide");
        const { dayId, slotId } = raw;
        if (!dayIds.has(dayId)) throw new Error(`Jour invalide: ${dayId}`);
        if (!slotIds.has(slotId) || slotId === "repas") throw new Error(`Créneau invalide: ${slotId}`);
        const text = cleanText(raw.text);
        const animaId = cleanAnimaId(raw.animaId);
        const prev =
          (animaId && take((t) => t.animaId === animaId)) ||
          take((t) => t.dayId === dayId && t.slotId === slotId && t.text === text) ||
          take((t) => !t.animaId && t.text === text);
        const key = dayId + "|" + slotId;
        const order = counters[key] = (counters[key] ?? -1) + 1;
        const task = {
          id: prev ? prev.id : newTaskId(),
          dayId,
          slotId,
          order,
          text,
          done: prev ? !!prev.done : false,
        };
        if (animaId) task.animaId = animaId;
        if (prev && prev.details) task.details = prev.details;
        if (typeof raw.ficheAnima === "string" && raw.ficheAnima.trim()) {
          const fiche = raw.ficheAnima.slice(0, DETAIL_TEXT_FIELDS.ficheAnima);
          if (!task.details || task.details.ficheAnima !== fiche) {
            task.details = { ...(task.details || {}), ficheAnima: fiche };
          }
        }
        next.push(task);
      }
      state.tasks = next;
      break;
    }

    case "reset": {
      requireOwner();
      for (const t of state.tasks) t.done = false;
      break;
    }

    case "setSchedule": {
      requireOwner();
      const { startDate, dayCount } = op;
      const newDays = buildDaysFromStart(startDate, dayCount); // throws on invalid
      const keep = new Set(newDays.map((d) => d.id));
      state.days = newDays;
      state.startDate = startDate;
      // Drop tasks whose day no longer exists, then recompact each surviving column.
      state.tasks = state.tasks.filter((t) => keep.has(t.dayId));
      for (const d of newDays) {
        for (const slot of state.slots) {
          if (slot.id === "repas") continue;
          reorderColumn(state, d.id, slot.id);
        }
      }
      break;
    }

    default:
      throw new Error(`Opération inconnue: ${op.op}`);
  }

  state.version = (state.version || 0) + 1;
  state.lastUpdated = Date.now();
  return state;
}

// Resolve which planning the request is about.  Priority:
//   1. ?planning=<id> query parameter
//   2. op.planningId in POST body
//   3. For authenticated users: their first accessible planning
//   4. For anonymous GETs: the first planning in the public list (empty if none)
async function resolvePlanningId(url, body, actorUser) {
  const fromQuery = url.searchParams.get("planning");
  if (fromQuery) return fromQuery;
  if (body && typeof body.planningId === "string" && body.planningId) return body.planningId;
  if (actorUser) {
    const list = await listPlanningsForUser(actorUser);
    if (list.length) return list[0].id;
  }
  return null;
}

export default async (req) => {
  corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...jsonHeaders, ...corsHeaders } });
  }

  await ensureMigration();
  const url = new URL(req.url);

  // ── GET /api/state ─────────────────────────────────────────────
  // Public read: requires an explicit ?planning=<id>.  The frontend passes
  // the currently selected planning so anonymous viewers can view a shared
  // link.  (The individual planning is the shareable unit.)
  if (req.method === "GET") {
    try {
      const planningId = url.searchParams.get("planning");
      if (!planningId) {
        return json({ error: "Paramètre 'planning' requis" }, { status: 400 });
      }
      const meta = await getPlanningMeta(planningId);
      if (!meta) return json({ error: "Planning introuvable" }, { status: 404 });
      const state = await getPlanningState(planningId);
      // Team members (cookie session or this planning's sync token) see the
      // full details; the public share link only sees the public part.
      let full = false;
      const auth = requireAuth(req, { allowSync: true });
      if (!auth.error) {
        const a = auth.user;
        full = a.scope === "sync" ? a.planningId === planningId : await userHasAccess(a.user, planningId);
      }
      return json({ ...(full ? state : publicView(state)), planningId, planningName: meta.name, fullAccess: full });
    } catch (e) {
      return json({ error: "Erreur de lecture: " + (e.message || e) }, { status: 500 });
    }
  }

  // ── POST /api/state ────────────────────────────────────────────
  if (req.method === "POST") {
    const auth = requireAuth(req, { allowSync: true });
    if (auth.error) return withCors(auth.error, corsHeaders);
    const actor = auth.user; // { user, role, scope?, planningId? }

    let body;
    try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }

    const planningId = await resolvePlanningId(url, body, actor.user);
    if (!planningId) return json({ error: "Paramètre 'planning' requis" }, { status: 400 });

    // A sync token only works on the planning it was issued for.
    if (actor.scope === "sync" && actor.planningId !== planningId) {
      return json({ error: "Jeton de synchro invalide pour ce planning" }, { status: 403 });
    }

    // Access control.
    const hasAccess = await userHasAccess(actor.user, planningId);
    if (!hasAccess) return json({ error: "Permission refusée" }, { status: 403 });

    const meta = await getPlanningMeta(planningId);
    if (!meta) return json({ error: "Planning introuvable" }, { status: 404 });

    // Pass ownership through to applyOp so destructive/structural ops
    // (reset, setSchedule) can require it.  Content ops are always allowed
    // for anyone who passed the access gate above.
    const effectiveActor = { ...actor, isOwner: meta.ownerId === actor.user };

    // Bulk replacement (Anima sync, version restore): keep a copy of what is
    // about to be overwritten.  Saved only once the replacement succeeded,
    // best-effort (never blocks the operation).
    let before = null;
    if (body.op === "replaceAll" && effectiveActor.isOwner) {
      try { before = await getPlanningState(planningId); } catch {}
    }

    try {
      const next = await updatePlanningState(planningId, (state) => {
        return applyOp(state, body, effectiveActor);
      });
      if (before) {
        try {
          await addSnapshot(planningId, {
            source: "netlify",
            label: typeof body.reason === "string" ? body.reason : "Avant remplacement",
            by: actor.user,
            data: netlifySnapshotData(before),
          });
        } catch (e) {
          console.error("snapshot failed", e);
        }
      }
      return json({ ...next, planningId, planningName: meta.name });
    } catch (e) {
      const message = e && e.message ? e.message : "Erreur interne";
      const status = /permission|refus/i.test(message) ? 403 : 400;
      return json({ error: message }, { status });
    }
  }

  return json({ error: "Method not allowed" }, { status: 405 });
};

export const config = { path: "/api/state" };
