import { getStore } from "@netlify/blobs";
import { updateJsonWithCAS } from "./cas.mjs";
import { buildInitialState } from "./seed.mjs";
import {
  addPlanningToUser,
  removePlanningFromAllUsers,
  loadUsers,
  getUsersStore,
  saveUsers,
  ensureBootstrapAdmin,
} from "./auth.mjs";

const INDEX_KEY = "index";
const LEGACY_STATE_KEY = "state";

export function getPlanningsStore() {
  return getStore({ name: "planning", consistency: "strong" });
}

function newPlanningId() {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function stateKey(planningId) {
  return `planning:${planningId}`;
}

export function isValidState(s) {
  return (
    s &&
    typeof s === "object" &&
    Array.isArray(s.days) &&
    Array.isArray(s.slots) &&
    Array.isArray(s.tasks)
  );
}

// Load the plannings index. Returns { plannings: { id: { id, name, ownerId, createdAt, lastUpdated } } }
export async function loadIndex(store) {
  const s = store || getPlanningsStore();
  const raw = await s.get(INDEX_KEY, { type: "json" });
  if (!raw || typeof raw !== "object" || typeof raw.plannings !== "object") {
    return { plannings: {} };
  }
  return raw;
}

async function saveIndex(store, index) {
  const s = store || getPlanningsStore();
  await s.set(INDEX_KEY, JSON.stringify(index));
}

// One-shot migration: if the legacy "state" key exists and no index is set,
// create a default planning from it and assign it to the bootstrap admin (or
// the oldest editor if none is set).
//
// Safe to call on every request; becomes a no-op once the index has at least
// one entry.
export async function ensureMigration() {
  const store = getPlanningsStore();
  const index = await loadIndex(store);
  if (Object.keys(index.plannings).length > 0) return index;

  // Look for legacy state blob.
  let legacy = null;
  try {
    const r = await store.getWithMetadata(LEGACY_STATE_KEY, { type: "json" });
    if (r && isValidState(r.data)) legacy = r.data;
  } catch {
    legacy = null;
  }

  // Pick an owner: first editor in the users store (ideally the bootstrap admin).
  const usersStore = getUsersStore();
  const users = await ensureBootstrapAdmin(usersStore);
  let ownerId = null;
  let oldest = Infinity;
  for (const [name, rec] of Object.entries(users)) {
    if (rec && rec.role === "editor") {
      const created = rec.createdAt || 0;
      if (created < oldest) {
        oldest = created;
        ownerId = name;
      }
    }
  }

  // If there's no editor yet, we can't migrate meaningfully — the first user
  // to be created will seed their own planning.  Bail out without touching
  // anything.
  if (!ownerId) return index;

  const id = "pl_default";
  const now = Date.now();
  const state = legacy
    ? { ...legacy, version: legacy.version || 1, lastUpdated: legacy.lastUpdated || now }
    : buildInitialState();

  await store.set(stateKey(id), JSON.stringify(state));
  index.plannings[id] = {
    id,
    name: legacy ? "Planning Stage BAFA Base" : "Mon planning",
    ownerId,
    createdAt: now,
    lastUpdated: state.lastUpdated || now,
  };
  await saveIndex(store, index);

  // Grant access to every existing user (they all used to share the single state).
  const allUsers = await loadUsers(usersStore);
  for (const rec of Object.values(allUsers)) {
    if (!Array.isArray(rec.plannings)) rec.plannings = [];
    if (!rec.plannings.includes(id)) rec.plannings.push(id);
  }
  await saveUsers(usersStore, allUsers);

  // Best-effort cleanup of the legacy key so we don't keep two copies.
  try { await store.delete(LEGACY_STATE_KEY); } catch {}

  return index;
}

// Public metadata shape used by the frontend.
function toPublicMeta(entry) {
  return {
    id: entry.id,
    name: entry.name,
    ownerId: entry.ownerId,
    createdAt: entry.createdAt,
    lastUpdated: entry.lastUpdated,
  };
}

// Return the list of plannings visible to `user` (based on their .plannings
// array).  Each entry includes metadata from the index.
export async function listPlanningsForUser(user) {
  await ensureMigration();
  const store = getPlanningsStore();
  const index = await loadIndex(store);
  const usersStore = getUsersStore();
  const users = await loadUsers(usersStore);
  const rec = users[user];
  const accessible = rec && Array.isArray(rec.plannings) ? rec.plannings : [];
  const out = [];
  for (const id of accessible) {
    const meta = index.plannings[id];
    if (meta) out.push(toPublicMeta(meta));
  }
  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return out;
}

export async function listAllPlannings() {
  await ensureMigration();
  const store = getPlanningsStore();
  const index = await loadIndex(store);
  return Object.values(index.plannings).map(toPublicMeta);
}

export async function getPlanningMeta(planningId) {
  const store = getPlanningsStore();
  const index = await loadIndex(store);
  const meta = index.plannings[planningId];
  return meta ? toPublicMeta(meta) : null;
}

// Create a new planning owned by `ownerId`.  The owner is automatically
// granted access (their users record is updated).
export async function createPlanning({ name, ownerId }) {
  await ensureMigration();
  const cleanName = (name || "").trim();
  if (!cleanName) throw new Error("Nom du planning obligatoire");
  if (cleanName.length > 80) throw new Error("Nom trop long (80 caractères max)");
  if (!ownerId) throw new Error("Propriétaire obligatoire");

  const store = getPlanningsStore();
  const id = newPlanningId();
  const now = Date.now();
  const state = buildInitialState();
  state.lastUpdated = now;

  await store.set(stateKey(id), JSON.stringify(state));

  const index = await loadIndex(store);
  index.plannings[id] = {
    id,
    name: cleanName,
    ownerId,
    createdAt: now,
    lastUpdated: now,
  };
  await saveIndex(store, index);

  await addPlanningToUser(ownerId, id);

  return toPublicMeta(index.plannings[id]);
}

export async function renamePlanning(planningId, name, by) {
  const store = getPlanningsStore();
  const index = await loadIndex(store);
  const meta = index.plannings[planningId];
  if (!meta) throw new Error("Planning introuvable");
  if (by && meta.ownerId !== by) throw new Error("Seul le propriétaire peut renommer");
  const cleanName = (name || "").trim();
  if (!cleanName) throw new Error("Nom obligatoire");
  if (cleanName.length > 80) throw new Error("Nom trop long (80 caractères max)");
  meta.name = cleanName;
  meta.lastUpdated = Date.now();
  await saveIndex(store, index);
  return toPublicMeta(meta);
}

export async function deletePlanning(planningId, by) {
  const store = getPlanningsStore();
  const index = await loadIndex(store);
  const meta = index.plannings[planningId];
  if (!meta) throw new Error("Planning introuvable");
  if (by && meta.ownerId !== by) throw new Error("Seul le propriétaire peut supprimer");
  delete index.plannings[planningId];
  await saveIndex(store, index);
  try { await store.delete(stateKey(planningId)); } catch {}
  await removePlanningFromAllUsers(planningId);
  return true;
}

// Fetch a planning's state blob.  Seeds a fresh state if missing (shouldn't
// normally happen after creation).
export async function getPlanningState(planningId) {
  const store = getPlanningsStore();
  const result = await store.getWithMetadata(stateKey(planningId), { type: "json" });
  let state = result ? result.data : null;
  if (!isValidState(state)) {
    state = buildInitialState();
    await store.set(stateKey(planningId), JSON.stringify(state));
  }
  return state;
}

// Apply a mutator to a planning state blob using CAS.
export async function updatePlanningState(planningId, mutator) {
  const store = getPlanningsStore();
  const next = await updateJsonWithCAS(
    store,
    stateKey(planningId),
    (current) => {
      let state = isValidState(current) ? current : buildInitialState();
      return mutator(state);
    },
    { fallback: () => buildInitialState() }
  );

  // Touch the index's lastUpdated.  Best-effort: if the index write loses
  // a CAS race we don't care, it'll heal on next write.
  try {
    const index = await loadIndex(store);
    if (index.plannings[planningId]) {
      index.plannings[planningId].lastUpdated = Date.now();
      await saveIndex(store, index);
    }
  } catch {}

  return next;
}

export async function userHasAccess(user, planningId) {
  const usersStore = getUsersStore();
  const users = await loadUsers(usersStore);
  const rec = users[user];
  if (!rec) return false;
  return Array.isArray(rec.plannings) && rec.plannings.includes(planningId);
}
