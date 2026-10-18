// Synchro planning-bafa <-> Anima Stages Manager (anima.lcdb-dev.eu).
//
// Same model as the "Synchro Anima" bookmarklet (public/anima-sync.js), but
// server to server: the Anima Stages Manager keeps the Anima planning
// ("planningmanager" field) in the same shape as the platform:
//   jours  { "j1_matin": [{type:"temps", id, formateur?}, ...], ... }
// and its bridge (/_gate/sync) returns, with the planning, the titles of the
// Anima catalog so both sides can be compared and relinked.
//
// Configuration (Netlify environment variables):
//   ASM_SYNC_URL    default https://anima.lcdb-dev.eu/_gate/sync
//   ASM_SYNC_TOKEN  bridge token (kept server side, never sent to browsers)

const DEFAULT_URL = "https://anima.lcdb-dev.eu/_gate/sync";
const SLOT_MAP = { matin: "matin", apm: "aprem", veillee: "veillee" };
const SLOT_MAP_BACK = { matin: "matin", aprem: "apm", veillee: "veillee" };
const KEY_RE = /^(j\d+)_(matin|apm|veillee)$/;
const MAX_TEXT = 300;

// ── Bridge client ───────────────────────────────────────────────
export function asmConfigured() {
  return !!process.env.ASM_SYNC_TOKEN;
}

export async function asmFetch(path, init = {}) {
  const base = (process.env.ASM_SYNC_URL || DEFAULT_URL).replace(/\/+$/, "");
  const res = await fetch(base + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + process.env.ASM_SYNC_TOKEN,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Anima Stages Manager : HTTP ${res.status}`);
    err.status = res.status;
    err.conflict = !!(data && data.conflict);
    throw err;
  }
  return data;
}

// ── Text helpers (same as anima-sync.js) ────────────────────────
function clean(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
export function norm(s) {
  return clean(s).toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[’'`]/g, "'").replace(/\s*:\s*/g, ":");
}
function entryId(e) {
  if (!e) return null;
  if (typeof e === "string") return e;
  if (e.type === "temps") return e.id;
  if (e.type === "groupe") return "groupe:" + e.typeProjet + ":" + e.nomGroupe;
  return null;
}
function titleFor(asm, id) {
  const f = asm.fiches && asm.fiches[id];
  if (f && f.titre) return clean(f.titre);
  if (asm.catalog && asm.catalog[id]) return clean(asm.catalog[id]);
  const g = /^groupe:([^:]*):(.*)$/.exec(id);
  if (g) return clean(g[1] + " : " + g[2]);
  return clean(id);
}
function ficheFor(asm, id) {
  const f = asm.fiches && asm.fiches[id];
  if (!f || !f.sommaire) return "";
  return ((f.duree ? "Durée Anima : " + f.duree + "\n" : "") + f.sommaire).slice(0, 6000);
}
function blockIds(t) {
  return Array.isArray(t.animaIds) && t.animaIds.length > 1 ? t.animaIds : null;
}

// ── Models: both sides reduced to { "j1|matin": [{text, animaId}] } ──
export function asmModel(asm) {
  const out = {};
  for (const [key, list] of Object.entries(asm.jours || {})) {
    const m = KEY_RE.exec(key);
    if (!m) continue;
    out[m[1] + "|" + SLOT_MAP[m[2]]] = (list || []).map((e) => {
      const id = entryId(e);
      return id ? { animaId: id, text: titleFor(asm, id) } : null;
    }).filter(Boolean);
  }
  return out;
}

function netlifyModel(state, asm) {
  const out = {};
  for (const d of state.days) {
    for (const s of state.slots) {
      if (s.id === "repas") continue;
      out[d.id + "|" + s.id] = state.tasks
        .filter((t) => t.dayId === d.id && t.slotId === s.id)
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .flatMap((t) => {
          const ids = blockIds(t);
          if (ids) return ids.map((id) => ({ text: titleFor(asm, id), animaId: id }));
          return [{ text: t.text, animaId: t.animaId || null }];
        });
    }
  }
  return out;
}

// Modules of a known planning-bafa block, consecutive and in the same order,
// come back as that single block (which keeps its details).
function collapseBlocks(items, state) {
  const blocks = state.tasks.map((t) => ({ t, ids: blockIds(t) })).filter((b) => b.ids);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const b = blocks.find((bl) => bl.ids.every((id, k) => items[i + k] && items[i + k].animaId === id));
    if (b) {
      out.push({ text: b.t.text, animaId: b.ids[0], animaIds: b.ids.slice(), block: true });
      i += b.ids.length - 1;
    } else {
      out.push(items[i]);
    }
  }
  return out;
}

function cellSig(items) { return items.map((i) => norm(i.text)).join("\n"); }

// Cells that differ, for the preview shown before choosing a direction.
export function diffCells(state, asm) {
  const a = asmModel(asm);
  const n = netlifyModel(state, asm);
  const netDays = new Set(state.days.map((d) => d.id));
  const cells = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(n)])) {
    const [day] = k.split("|");
    const ai = a[k] || [], ni = n[k] || [];
    if (!netDays.has(day)) {
      if (ai.length) cells.push({ key: k, outil: ai.map((i) => i.text), planning: null, outOfRange: true });
      continue;
    }
    if (cellSig(ai) !== cellSig(ni)) {
      cells.push({ key: k, outil: ai.map((i) => i.text), planning: ni.map((i) => i.text) });
    }
  }
  const dayNum = (k) => parseInt(k.slice(1), 10);
  const slotNum = (k) => ["matin", "aprem", "veillee"].indexOf(k.split("|")[1]);
  return cells.sort((x, y) => dayNum(x.key) - dayNum(y.key) || slotNum(x.key) - slotNum(y.key));
}

// Outil -> planning-bafa : the task list for the existing "replaceAll" op.
export function asmToTasks(state, asm) {
  const a = asmModel(asm);
  const tasks = [];
  for (const d of state.days) {
    for (const s of ["matin", "aprem", "veillee"]) {
      for (const it of collapseBlocks(a[d.id + "|" + s] || [], state)) {
        const text = (it.text || it.animaId || "").slice(0, MAX_TEXT);
        if (!text) continue;
        if (it.block) {
          tasks.push({ dayId: d.id, slotId: s, text, animaId: it.animaId, animaIds: it.animaIds });
          continue;
        }
        const fiche = ficheFor(asm, it.animaId);
        tasks.push({ dayId: d.id, slotId: s, text, animaId: it.animaId, ...(fiche ? { ficheAnima: fiche } : {}) });
      }
    }
  }
  return tasks;
}

// planning-bafa -> Outil : the new "jours" for the Anima Stages Manager.
// Cells of days unknown to planning-bafa are kept as they are; existing
// entries keep their formateur assignment; items typed by hand are relinked
// to the Anima catalog by title when one matches exactly.
export function netlifyToJours(state, asm) {
  const jours = asm.jours || {};
  const byTitle = {};
  for (const [id, titre] of Object.entries(asm.catalog || {})) {
    if (titre) byTitle[norm(titre)] = id;
  }
  const existing = {};
  for (const list of Object.values(jours)) {
    for (const e of list || []) {
      const id = entryId(e);
      if (id && !existing[id]) existing[id] = typeof e === "string" ? { type: "temps", id: e } : e;
    }
  }
  const entryFor = (id) => {
    if (existing[id]) return existing[id];
    const g = /^groupe:([^:]*):(.*)$/.exec(id);
    if (g) return { type: "groupe", typeProjet: g[1], nomGroupe: g[2] };
    return { type: "temps", id };
  };
  // Slots of the stage: those it already has, plus every slot of its days.
  let maxDay = 0;
  for (const k of Object.keys(jours)) {
    const m = KEY_RE.exec(k);
    if (m) maxDay = Math.max(maxDay, parseInt(m[1].slice(1), 10));
  }
  // Empty planning on the Outil side: take the days of planning-bafa.
  const emptyStage = maxDay === 0;
  if (emptyStage) maxDay = state.days.length;
  const keys = new Set(Object.keys(jours).filter((k) => KEY_RE.test(k)));
  for (let i = 1; i <= maxDay; i++) for (const s of ["matin", "apm", "veillee"]) keys.add(`j${i}_${s}`);

  const netDays = new Set(state.days.map((d) => d.id));
  const next = {};
  const relinked = [];
  for (const key of keys) {
    const m = KEY_RE.exec(key);
    if (!netDays.has(m[1])) { if (jours[key]) next[key] = jours[key]; continue; }
    const slotId = SLOT_MAP[m[2]];
    next[key] = state.tasks
      .filter((t) => t.dayId === m[1] && t.slotId === slotId)
      .sort((x, y) => (x.order || 0) - (y.order || 0))
      .flatMap((t) => {
        const ids = blockIds(t);
        if (ids) return ids.map(entryFor);
        const id = t.animaId || byTitle[norm(t.text)] || t.text;
        if (!t.animaId && id !== t.text) relinked.push(t.text);
        return [entryFor(id)];
      });
  }
  const ignored = state.days.filter((d) => parseInt(d.id.slice(1), 10) > maxDay).map((d) => d.id);
  return { jours: next, relinked, ignoredDays: emptyStage ? [] : ignored };
}

export { SLOT_MAP_BACK };
