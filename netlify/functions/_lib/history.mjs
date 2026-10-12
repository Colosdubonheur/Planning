// Version history for plannings.
//
// Each snapshot is one blob in the "planning-history" store, keyed
// `<planningId>/<timestamp>-<source>` so a prefix listing returns them in
// chronological order without reading every blob.
//
//   source "netlify": copy of the planning-bafa state ({ days, slots, tasks })
//   source "anima"  : raw copy of the Anima planning manager
//                     ({ jours: { j1_matin: [...] }, titles: { id: titre } })
import { getStore } from "@netlify/blobs";

const MAX_PER_PLANNING = 200;
const SOURCES = new Set(["netlify", "anima"]);

export function getHistoryStore() {
  return getStore({ name: "planning-history", consistency: "strong" });
}

function parseKey(key) {
  const m = /^([^/]+)\/(\d+)-(netlify|anima)$/.exec(key);
  if (!m) return null;
  return { id: `${m[2]}-${m[3]}`, planningId: m[1], at: Number(m[2]), source: m[3] };
}

export async function listSnapshots(planningId) {
  const store = getHistoryStore();
  const { blobs } = await store.list({ prefix: `${planningId}/` });
  return blobs
    .map((b) => parseKey(b.key))
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
}

export async function getSnapshot(planningId, snapId) {
  if (!/^\d+-(netlify|anima)$/.test(String(snapId))) return null;
  const store = getHistoryStore();
  return store.get(`${planningId}/${snapId}`, { type: "json" });
}

export async function addSnapshot(planningId, { source, label, by, data }) {
  if (!SOURCES.has(source)) throw new Error("Source de version invalide");
  if (!data || typeof data !== "object") throw new Error("Contenu de version manquant");
  const raw = JSON.stringify(data);
  if (raw.length > 500_000) throw new Error("Version trop volumineuse");
  const at = Date.now();
  const id = `${at}-${source}`;
  const store = getHistoryStore();
  await store.setJSON(`${planningId}/${id}`, {
    id,
    at,
    source,
    label: typeof label === "string" ? label.slice(0, 120) : "",
    by: by || null,
    data,
  });
  // Keep the history bounded: drop the oldest snapshots.
  try {
    const all = await listSnapshots(planningId);
    for (const old of all.slice(MAX_PER_PLANNING)) {
      await store.delete(`${planningId}/${old.id}`);
    }
  } catch {}
  return { id, at, source };
}

// Snapshot of the planning-bafa side, reduced to what is needed to restore.
export function netlifySnapshotData(state) {
  return {
    days: state.days,
    slots: state.slots,
    tasks: (state.tasks || []).map((t) => ({
      dayId: t.dayId,
      slotId: t.slotId,
      order: t.order,
      text: t.text,
      done: !!t.done,
      ...(t.animaId ? { animaId: t.animaId } : {}),
    })),
  };
}
