import { getStore } from "@netlify/blobs";

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const store = getStore("planning");

  if (req.method === "GET") {
    try {
      const raw = await store.get("state");
      if (!raw) return new Response(JSON.stringify({ tasks: {}, lastUpdated: 0 }), { headers });
      return new Response(raw, { headers });
    } catch (e) {
      return new Response(JSON.stringify({ tasks: {}, lastUpdated: 0 }), { headers });
    }
  }

  if (req.method === "POST") {
    try {
      const raw = await req.text();
      JSON.parse(raw);
      await store.set("state", raw);
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, headers });
    }
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
};

export const config = { path: "/api/state" };
