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

async function loadUsers(store) {
  const raw = await store.get("users");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function saveUsers(store, users) {
  await store.set("users", JSON.stringify(users));
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

export async function listUsers() {
  const store = getUsersStore();
  const users = await ensureBootstrapAdmin(store);
  return Object.entries(users).map(([user, rec]) => ({
    user,
    role: rec.role,
    createdAt: rec.createdAt,
  }));
}

export async function createUser({ user, password, role }) {
  if (!user || !password || !role) throw new Error("user, password et role sont obligatoires");
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(user)) throw new Error("Identifiant invalide (2-32 caractères, alphanumérique)");
  if (password.length < 6) throw new Error("Mot de passe trop court (6 caractères minimum)");
  if (role !== "editor" && role !== "validator") throw new Error("Rôle invalide");
  const store = getUsersStore();
  const users = await loadUsers(store);
  if (users[user]) throw new Error("Ce nom d'utilisateur existe déjà");
  users[user] = {
    passwordHash: hashPassword(password),
    role,
    createdAt: Date.now(),
  };
  await saveUsers(store, users);
  return { user, role, createdAt: users[user].createdAt };
}

export async function deleteUser(user) {
  const store = getUsersStore();
  const users = await loadUsers(store);
  if (!users[user]) throw new Error("Utilisateur introuvable");
  delete users[user];
  await saveUsers(store, users);
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
