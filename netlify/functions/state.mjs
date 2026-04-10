import { getStore } from "@netlify/blobs";
import { requireAuth } from "./_lib/auth.mjs";
import { updateJsonWithCAS } from "./_lib/cas.mjs";
import { buildInitialState } from "./_lib/seed.mjs";

const jsonHeaders = { "Content-Type": "application/json" };

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...jsonHeaders, ...(init.headers || {}) },
  });
}

function newTaskId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isValidState(s) {
  return (
    s &&
    typeof s === "object" &&
    Array.isArray(s.days) &&
    Array.isArray(s.slots) &&
    Array.isArray(s.tasks)
  );
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

  switch (op.op) {
    case "toggle": {
      const task = state.tasks.find((t) => t.id === op.taskId);
      if (!task) throw new Error("Tâche introuvable");
      task.done = !!op.done;
      break;
    }

    case "edit": {
      if (actor.role !== "editor") throw new Error("Permission refusée");
      const task = state.tasks.find((t) => t.id === op.taskId);
      if (!task) throw new Error("Tâche introuvable");
      if (typeof op.text !== "string") throw new Error("Texte manquant");
      const text = op.text.trim();
      if (!text) throw new Error("Le texte ne peut pas être vide");
      if (text.length > 300) throw new Error("Texte trop long (300 caractères max)");
      task.text = text;
      break;
    }

    case "add": {
      if (actor.role !== "editor") throw new Error("Permission refusée");
      const { dayId, slotId } = op;
      if (!state.days.some((d) => d.id === dayId)) throw new Error("Jour invalide");
      if (!state.slots.some((s) => s.id === slotId)) throw new Error("Créneau invalide");
      if (slotId === "repas") throw new Error("Le créneau Repas n'est pas éditable");
      const text = (op.text || "").trim();
      if (!text) throw new Error("Le texte ne peut pas être vide");
      if (text.length > 300) throw new Error("Texte trop long (300 caractères max)");
      const existing = state.tasks.filter((t) => t.dayId === dayId && t.slotId === slotId);
      const order = existing.length;
      state.tasks.push({
        id: newTaskId(),
        dayId,
        slotId,
        order,
        text,
        done: false,
      });
      break;
    }

    case "remove": {
      if (actor.role !== "editor") throw new Error("Permission refusée");
      const idx = state.tasks.findIndex((t) => t.id === op.taskId);
      if (idx === -1) throw new Error("Tâche introuvable");
      const removed = state.tasks[idx];
      state.tasks.splice(idx, 1);
      reorderColumn(state, removed.dayId, removed.slotId);
      break;
    }

    case "move": {
      if (actor.role !== "editor") throw new Error("Permission refusée");
      const task = state.tasks.find((t) => t.id === op.taskId);
      if (!task) throw new Error("Tâche introuvable");
      if (!state.days.some((d) => d.id === op.dayId)) throw new Error("Jour invalide");
      if (!state.slots.some((s) => s.id === op.slotId)) throw new Error("Créneau invalide");
      if (op.slotId === "repas") throw new Error("Le créneau Repas n'est pas éditable");
      const oldDayId = task.dayId;
      const oldSlotId = task.slotId;
      task.dayId = op.dayId;
      task.slotId = op.slotId;
      const destCount = state.tasks.filter(
        (t) => t.dayId === op.dayId && t.slotId === op.slotId && t.id !== task.id
      ).length;
      task.order = destCount;
      if (oldDayId !== op.dayId || oldSlotId !== op.slotId) {
        reorderColumn(state, oldDayId, oldSlotId);
      }
      reorderColumn(state, op.dayId, op.slotId);
      break;
    }

    case "reset": {
      if (actor.role !== "editor") throw new Error("Permission refusée");
      for (const t of state.tasks) t.done = false;
      break;
    }

    default:
      throw new Error(`Opération inconnue: ${op.op}`);
  }

  state.version = (state.version || 0) + 1;
  state.lastUpdated = Date.now();
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: jsonHeaders });
  }

  const auth = requireAuth(req);
  if (auth.error) return auth.error;
  const actor = auth.user; // { user, role }

  const store = getStore({ name: "planning", consistency: "strong" });

  if (req.method === "GET") {
    try {
      const result = await store.getWithMetadata("state", { type: "json" });
      let state = result ? result.data : null;
      if (!isValidState(state)) {
        // First boot or legacy format — seed it.
        state = buildInitialState();
        await store.set("state", JSON.stringify(state));
      }
      return json(state);
    } catch (e) {
      return json({ error: "Erreur de lecture: " + (e.message || e) }, { status: 500 });
    }
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }

    try {
      const next = await updateJsonWithCAS(
        store,
        "state",
        (current) => {
          let state = isValidState(current) ? current : buildInitialState();
          applyOp(state, body, actor);
          return state;
        },
        { fallback: () => buildInitialState() }
      );
      return json(next);
    } catch (e) {
      const message = e && e.message ? e.message : "Erreur interne";
      const status = /permission|refus/i.test(message) ? 403 : 400;
      return json({ error: message }, { status });
    }
  }

  return json({ error: "Method not allowed" }, { status: 405 });
};

export const config = { path: "/api/state" };
