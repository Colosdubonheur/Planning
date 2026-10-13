// /api/invites: invitation links to a planning.
//
//   POST   /api/invites               { planningId }  owner: create a link
//   GET    /api/invites?planning=<id>                 owner: list links
//   DELETE /api/invites?id=<inviteId>                 owner: revoke a link
//   GET    /api/invites?id=<inviteId>                 public: what the link is
//   POST   /api/invites/accept        { id, user?, password? }
//          - logged in: join with the current account
//          - otherwise: create a formateur account (child of the inviter)
//            and log in
import {
  requireAuth,
  createUser,
  addPlanningToUser,
  authenticate,
  signToken,
  buildAuthCookie,
  getUser,
} from "./_lib/auth.mjs";
import { ensureMigration, getPlanningMeta, userHasAccess } from "./_lib/plannings.mjs";
import {
  createInvite,
  saveInvitePointer,
  getInvite,
  inviteStatus,
  listInvites,
  updateInvite,
} from "./_lib/invites.mjs";

const jsonHeaders = { "Content-Type": "application/json" };
const json = (body, init = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { ...jsonHeaders, ...(init.headers || {}) } });

function publicInvite(inv) {
  return {
    id: inv.id,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    status: inviteStatus(inv),
    uses: (inv.uses || []).map((u) => ({ user: u.user, at: u.at, created: !!u.created })),
  };
}

async function requireOwner(req, planningId) {
  const auth = requireAuth(req);
  if (auth.error) return { error: auth.error };
  const meta = await getPlanningMeta(planningId);
  if (!meta) return { error: json({ error: "Planning introuvable" }, { status: 404 }) };
  if (meta.ownerId !== auth.user.user || !(await userHasAccess(auth.user.user, planningId))) {
    return { error: json({ error: "Réservé au propriétaire du planning" }, { status: 403 }) };
  }
  return { user: auth.user, meta };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: jsonHeaders });
  await ensureMigration();
  const url = new URL(req.url);
  const isAccept = url.pathname.replace(/\/$/, "").endsWith("/accept");

  try {
    // ── Accept an invitation ──────────────────────────────────
    if (isAccept && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }
      const inv = await getInvite(body && body.id);
      const status = inviteStatus(inv);
      if (status !== "valide") {
        return json({ error: status === "expire" ? "Ce lien d'invitation a expiré" : "Ce lien d'invitation n'est plus valide" }, { status: 410 });
      }
      const meta = await getPlanningMeta(inv.planningId);
      if (!meta) return json({ error: "Planning introuvable" }, { status: 404 });

      const session = requireAuth(req);
      let username;
      let created = false;
      let headers = {};
      if (!session.error) {
        // Already logged in: just join.
        username = session.user.user;
        await addPlanningToUser(username, inv.planningId);
      } else {
        const user = String((body && body.user) || "").trim();
        const password = String((body && body.password) || "");
        const existing = user ? await getUser(user) : null;
        if (existing) {
          // Existing account: must prove it with its password.
          const ok = await authenticate(user, password);
          if (!ok) return json({ error: "Cet identifiant existe déjà : mot de passe incorrect" }, { status: 401 });
          username = ok.user;
          await addPlanningToUser(username, inv.planningId);
          headers["Set-Cookie"] = buildAuthCookie(signToken({ user: ok.user, role: ok.role }));
        } else {
          await createUser({
            user,
            password,
            role: "formateur",
            parent: inv.createdBy,
            plannings: [inv.planningId],
          });
          created = true;
          username = user;
          headers["Set-Cookie"] = buildAuthCookie(signToken({ user, role: "formateur" }));
        }
      }
      inv.uses = [...(inv.uses || []), { user: username, at: Date.now(), created }].slice(-50);
      await updateInvite(inv);
      return json({ ok: true, user: username, created, planningId: inv.planningId, planningName: meta.name }, { headers });
    }

    // ── Public: describe an invitation (landing page) ─────────
    if (req.method === "GET" && url.searchParams.get("id")) {
      const inv = await getInvite(url.searchParams.get("id"));
      const status = inviteStatus(inv);
      if (status === "introuvable") return json({ status }, { status: 404 });
      const meta = await getPlanningMeta(inv.planningId);
      return json({ status, planningId: inv.planningId, planningName: meta ? meta.name : "", invitedBy: inv.createdBy });
    }

    // ── Owner: list ───────────────────────────────────────────
    if (req.method === "GET") {
      const planningId = url.searchParams.get("planning");
      if (!planningId) return json({ error: "Paramètre 'planning' requis" }, { status: 400 });
      const own = await requireOwner(req, planningId);
      if (own.error) return own.error;
      const list = await listInvites(planningId);
      return json({ invites: list.map(publicInvite) });
    }

    // ── Owner: create ─────────────────────────────────────────
    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "JSON invalide" }, { status: 400 }); }
      const planningId = body && body.planningId;
      if (!planningId) return json({ error: "Paramètre 'planningId' requis" }, { status: 400 });
      const own = await requireOwner(req, planningId);
      if (own.error) return own.error;
      const inv = await createInvite({ planningId, createdBy: own.user.user });
      await saveInvitePointer(inv);
      return json({ invite: publicInvite(inv) }, { status: 201 });
    }

    // ── Owner: revoke ─────────────────────────────────────────
    if (req.method === "DELETE") {
      const inv = await getInvite(url.searchParams.get("id"));
      if (!inv) return json({ error: "Invitation introuvable" }, { status: 404 });
      const own = await requireOwner(req, inv.planningId);
      if (own.error) return own.error;
      inv.revoked = true;
      await updateInvite(inv);
      return json({ invite: publicInvite(inv) });
    }
  } catch (e) {
    return json({ error: e.message || "Erreur interne" }, { status: 400 });
  }

  return json({ error: "Method not allowed" }, { status: 405 });
};

export const config = { path: ["/api/invites", "/api/invites/accept"] };
