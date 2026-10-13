// Invitation links: the owner of a planning shares a link (WhatsApp...) and
// whoever opens it creates their own formateur account (or, if already
// registered, joins with their existing one) and gets access to that
// planning.  Links are random, multi-use until they expire or are revoked.
import { getStore } from "@netlify/blobs";
import { randomBytes } from "node:crypto";

const DEFAULT_DAYS = 14;

export function getInvitesStore() {
  return getStore({ name: "planning-invites", consistency: "strong" });
}

function isValidId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(id);
}

export async function createInvite({ planningId, createdBy, days = DEFAULT_DAYS }) {
  const id = randomBytes(18).toString("base64url");
  const now = Date.now();
  const invite = {
    id,
    planningId,
    createdBy,
    role: "formateur",
    createdAt: now,
    expiresAt: now + days * 24 * 3600 * 1000,
    revoked: false,
    uses: [],
  };
  await getInvitesStore().setJSON(`${planningId}/${id}`, invite);
  return invite;
}

// Invites are keyed by planning so the owner can list them; lookups by id
// alone go through a small pointer blob.
export async function saveInvitePointer(invite) {
  await getInvitesStore().setJSON(`by-id/${invite.id}`, { planningId: invite.planningId });
}

export async function getInvite(id) {
  if (!isValidId(id)) return null;
  const store = getInvitesStore();
  const ptr = await store.get(`by-id/${id}`, { type: "json" });
  if (!ptr || !ptr.planningId) return null;
  return store.get(`${ptr.planningId}/${id}`, { type: "json" });
}

export function inviteStatus(invite) {
  if (!invite) return "introuvable";
  if (invite.revoked) return "revoque";
  if (Date.now() > invite.expiresAt) return "expire";
  return "valide";
}

export async function listInvites(planningId) {
  const store = getInvitesStore();
  const { blobs } = await store.list({ prefix: `${planningId}/` });
  const out = [];
  for (const b of blobs) {
    const inv = await store.get(b.key, { type: "json" });
    if (inv) out.push(inv);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateInvite(invite) {
  await getInvitesStore().setJSON(`${invite.planningId}/${invite.id}`, invite);
}
