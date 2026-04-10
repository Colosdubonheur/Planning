import { getStore } from "@netlify/blobs";
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

const TOKEN_TTL_SEC = 7 * 24 * 3600; // 7 days
const COOKIE_NAME = "planning_auth";

function getSecret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("AUTH_SECRET env var is missing or too short (need >= 16 chars)");
  }
  return s;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, hashHex] = stored.split("$");
    if (algo !== "scrypt") return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function signToken(payload) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC };
  const bodyEnc = b64urlEncode(JSON.stringify(body));
  const sig = createHmac("sha256", getSecret()).update(bodyEnc).digest();
  return `${bodyEnc}.${b64urlEncode(sig)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [bodyEnc, sigEnc] = parts;
  const expectedSig = createHmac("sha256", getSecret()).update(bodyEnc).digest();
  let providedSig;
  try { providedSig = b64urlDecode(sigEnc); } catch { return null; }
  if (expectedSig.length !== providedSig.length) return null;
  if (!timingSafeEqual(expectedSig, providedSig)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(bodyEnc).toString("utf8")); } catch { return null; }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (!payload.user || !payload.role) return null;
  return { user: payload.user, role: payload.role, exp: payload.exp };
}

export function buildAuthCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TOKEN_TTL_SEC}`;
}

export function buildClearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function extractTokenFromRequest(req) {
  const cookieHeader = req.headers.get("cookie") || "";
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === COOKIE_NAME) return value;
  }
  return null;
}

export function getUsersStore() {
  return getStore({ name: "planning-users", consistency: "strong" });
}

export async function loadUsers(store) {
  const raw = await (store || getUsersStore()).get("users");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    // Ensure every record has the expected shape (hierarchy fields added later).
    for (const [name, rec] of Object.entries(parsed)) {
      if (!rec || typeof rec !== "object") continue;
      if (!Array.isArray(rec.plannings)) rec.plannings = [];
      if (rec.parent === undefined) rec.parent = null;
    }
    return parsed;
  } catch {
    return {};
  }
}

export async function saveUsers(store, users) {
  await (store || getUsersStore()).set("users", JSON.stringify(users));
}

export async function ensureBootstrapAdmin(store) {
  const users = await loadUsers(store);
  if (Object.keys(users).length > 0) return users;
  const adminUser = process.env.BOOTSTRAP_ADMIN_USER;
  const adminPwd = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!adminUser || !adminPwd) return users;
  users[adminUser] = {
    passwordHash: hashPassword(adminPwd),
    role: "editor",
    parent: null,
    plannings: [],
    createdAt: Date.now(),
  };
  await saveUsers(store, users);
  return users;
}

export async function authenticate(user, password) {
  const store = getUsersStore();
  const users = await ensureBootstrapAdmin(store);
  const record = users[user];
  if (!record) return null;
  if (!verifyPassword(password, record.passwordHash)) return null;
  return { user, role: record.role };
}

// ── Hierarchy helpers ──────────────────────────────────────────

// Return true if `user` is `ancestor` or descends from `ancestor`.
export function isInSubtree(user, ancestor, users) {
  if (!users[user]) return false;
  let cursor = user;
  const seen = new Set();
  while (cursor) {
    if (cursor === ancestor) return true;
    if (seen.has(cursor)) return false; // cycle guard
    seen.add(cursor);
    const rec = users[cursor];
    if (!rec) return false;
    cursor = rec.parent || null;
  }
  return false;
}

// Return all users (including self) that descend from `root`.
export function getSubtree(root, users) {
  const result = [];
  for (const name of Object.keys(users)) {
    if (isInSubtree(name, root, users)) result.push(name);
  }
  return result;
}

// List users visible to `viewer`: viewer + their descendants.
export async function listUsersFor(viewer) {
  const store = getUsersStore();
  const users = await loadUsers(store);
  const visible = getSubtree(viewer, users);
  return visible
    .map((name) => {
      const rec = users[name];
      return {
        user: name,
        role: rec.role,
        parent: rec.parent || null,
        plannings: Array.isArray(rec.plannings) ? [...rec.plannings] : [],
        createdAt: rec.createdAt || 0,
      };
    })
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function createUser({ user, password, role, parent, plannings }) {
  if (!user || !password || !role) throw new Error("user, password et role sont obligatoires");
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(user)) throw new Error("Identifiant invalide (2-32 caractères, alphanumérique)");
  if (password.length < 6) throw new Error("Mot de passe trop court (6 caractères minimum)");
  if (role !== "editor" && role !== "validator") throw new Error("Rôle invalide");
  const store = getUsersStore();
  const users = await loadUsers(store);
  if (users[user]) throw new Error("Ce nom d'utilisateur existe déjà");
  if (parent && !users[parent]) throw new Error("Utilisateur parent introuvable");

  // If plannings specified, the parent must have access to each.
  const parentPlannings = parent && users[parent] && Array.isArray(users[parent].plannings)
    ? new Set(users[parent].plannings)
    : null;
  const initialPlannings = Array.isArray(plannings) ? plannings.filter((p) => typeof p === "string") : [];
  if (parentPlannings) {
    for (const pid of initialPlannings) {
      if (!parentPlannings.has(pid)) {
        throw new Error("Impossible d'affecter à un planning non accessible au créateur");
      }
    }
  }

  users[user] = {
    passwordHash: hashPassword(password),
    role,
    parent: parent || null,
    plannings: initialPlannings,
    createdAt: Date.now(),
  };
  await saveUsers(store, users);
  return {
    user,
    role,
    parent: parent || null,
    plannings: [...initialPlannings],
    createdAt: users[user].createdAt,
  };
}

// Delete `user` (and all their descendants). Reparent is NOT supported; the
// whole subtree is removed.  Returns the list of removed usernames.
export async function deleteUserCascade(user) {
  const store = getUsersStore();
  const users = await loadUsers(store);
  if (!users[user]) throw new Error("Utilisateur introuvable");
  const toRemove = getSubtree(user, users);
  for (const name of toRemove) {
    delete users[name];
  }
  await saveUsers(store, users);
  return toRemove;
}

// Grant `user` access to planning `planningId`. `by` is the acting user
// (used to verify authorization) and `by` must have access to the planning.
// `user` must be in `by`'s subtree (or `by` itself).
export async function grantPlanningAccess(user, planningId, by) {
  const store = getUsersStore();
  const users = await loadUsers(store);
  if (!users[user]) throw new Error("Utilisateur introuvable");
  if (!users[by]) throw new Error("Utilisateur appelant introuvable");
  if (!isInSubtree(user, by, users)) throw new Error("Permission refusée (hors sous-arbre)");
  const byPlannings = Array.isArray(users[by].plannings) ? users[by].plannings : [];
  if (!byPlannings.includes(planningId)) {
    throw new Error("Vous n'avez pas accès à ce planning");
  }
  const cur = Array.isArray(users[user].plannings) ? users[user].plannings : [];
  if (!cur.includes(planningId)) cur.push(planningId);
  users[user].plannings = cur;
  await saveUsers(store, users);
  return [...cur];
}

export async function revokePlanningAccess(user, planningId, by) {
  const store = getUsersStore();
  const users = await loadUsers(store);
  if (!users[user]) throw new Error("Utilisateur introuvable");
  if (!users[by]) throw new Error("Utilisateur appelant introuvable");
  if (!isInSubtree(user, by, users)) throw new Error("Permission refusée (hors sous-arbre)");
  // The caller can't revoke their own access through this endpoint.
  if (user === by) throw new Error("Impossible de révoquer votre propre accès");
  const cur = Array.isArray(users[user].plannings) ? users[user].plannings : [];
  users[user].plannings = cur.filter((p) => p !== planningId);
  await saveUsers(store, users);
  return [...users[user].plannings];
}

// Remove a planning from every user's access list (used when a planning is
// deleted).  Returns the number of users touched.
export async function removePlanningFromAllUsers(planningId) {
  const store = getUsersStore();
  const users = await loadUsers(store);
  let touched = 0;
  for (const rec of Object.values(users)) {
    if (!Array.isArray(rec.plannings)) continue;
    const next = rec.plannings.filter((p) => p !== planningId);
    if (next.length !== rec.plannings.length) {
      rec.plannings = next;
      touched++;
    }
  }
  if (touched) await saveUsers(store, users);
  return touched;
}

// Append a planning ID to a user's access list. Used when they create a new
// planning: they automatically become an owner with access.
export async function addPlanningToUser(user, planningId) {
  const store = getUsersStore();
  const users = await loadUsers(store);
  if (!users[user]) throw new Error("Utilisateur introuvable");
  const cur = Array.isArray(users[user].plannings) ? users[user].plannings : [];
  if (!cur.includes(planningId)) cur.push(planningId);
  users[user].plannings = cur;
  await saveUsers(store, users);
  return [...cur];
}

// Load a single user record (returns null if not found).
export async function getUser(user) {
  const store = getUsersStore();
  const users = await ensureBootstrapAdmin(store);
  const rec = users[user];
  if (!rec) return null;
  return {
    user,
    role: rec.role,
    parent: rec.parent || null,
    plannings: Array.isArray(rec.plannings) ? [...rec.plannings] : [],
    createdAt: rec.createdAt || 0,
  };
}

export function requireAuth(req, { role } = {}) {
  const token = extractTokenFromRequest(req);
  const payload = verifyToken(token);
  if (!payload) {
    return { error: new Response(JSON.stringify({ error: "Non authentifié" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }) };
  }
  if (role && payload.role !== role) {
    return { error: new Response(JSON.stringify({ error: "Permission refusée" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }) };
  }
  return { user: payload };
}

export { COOKIE_NAME };
