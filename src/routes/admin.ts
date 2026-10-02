// The admin API: reset, health, and the users and clients an app under test needs to register.
// Unauthenticated by design (the server binds 127.0.0.1 by default) and without CORS in MVP1.
import { type Context, Hono } from "hono";
import type { AppEnv } from "../app";
import { adminError } from "../errors";
import {
  normalizeClient,
  type PrepareResult,
  prepareUser,
  toFixtureUser,
  zodIssues,
} from "../fixtures/load";
import { FixtureClient } from "../fixtures/schema";

type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

/** Reads a JSON body; a wrong Content-Type or malformed JSON is a 400, never a 500. */
async function readJson(c: Context<AppEnv>): Promise<JsonBody> {
  const contentType = c.req.header("content-type") ?? "";
  if (!/^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(contentType)) {
    return {
      ok: false,
      response: adminError(c, 400, "invalid_request", [
        { path: "", message: "Content-Type must be application/json" },
      ]),
    };
  }
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return {
      ok: false,
      response: adminError(c, 400, "invalid_request", [
        { path: "", message: "The request body is not valid JSON" },
      ]),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The response for a user the store would not take: 400 with every issue, or 409. */
function rejection(c: Context<AppEnv>, prepared: Exclude<PrepareResult, { ok: true }>): Response {
  return prepared.kind === "conflict"
    ? adminError(c, 409, "conflict")
    : adminError(c, 400, "invalid_fixture", prepared.issues);
}

export function adminRoutes(): Hono<AppEnv> {
  const admin = new Hono<AppEnv>();

  async function counts(c: Context<AppEnv>) {
    const { store } = c.get("deps");
    return {
      status: "ok",
      users: (await store.listUsers()).length,
      clients: (await store.listClients()).length,
    };
  }

  admin.get("/health", async (c) => c.json(await counts(c)));

  admin.post("/reset", async (c) => {
    await c.get("deps").store.reset();
    return c.json(await counts(c));
  });

  admin.get("/users", async (c) => {
    const users = await c.get("deps").store.listUsers();
    return c.json(users.map(toFixtureUser));
  });

  admin.get("/users/:orcid", async (c) => {
    const user = await c.get("deps").store.getUser(c.req.param("orcid"));
    return user ? c.json(toFixtureUser(user)) : adminError(c, 404, "not_found");
  });

  // Create only: an omitted or empty `orcid` mints one; an existing iD is a 409.
  admin.post("/users", async (c) => {
    const { store } = c.get("deps");
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const prepared = await prepareUser(store, body.value, { mode: "create" }, Date.now());
    if (!prepared.ok) return rejection(c, prepared);
    if ((await store.insertUser(prepared.user)) === "conflict") {
      return adminError(c, 409, "conflict");
    }
    return c.json(toFixtureUser(prepared.user), 201);
  });

  // Upsert: the path iD wins, and a body `orcid` that differs from it is a 400.
  admin.put("/users/:orcid", async (c) => {
    const { store } = c.get("deps");
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const prepared = await prepareUser(
      store,
      body.value,
      { mode: "upsert", pathOrcid: c.req.param("orcid") },
      Date.now(),
    );
    if (!prepared.ok) return rejection(c, prepared);
    const outcome = await store.upsertUser(prepared.user);
    return c.json(toFixtureUser(prepared.user), outcome === "created" ? 201 : 200);
  });

  admin.delete("/users/:orcid", async (c) => {
    const removed = await c.get("deps").store.deleteUser(c.req.param("orcid"));
    return removed ? c.body(null, 204) : adminError(c, 404, "not_found");
  });

  // Upsert a client, so an app under test on a random port can register its redirect_uri.
  admin.put("/clients/:client_id", async (c) => {
    const { store } = c.get("deps");
    const clientId = c.req.param("client_id");
    const body = await readJson(c);
    if (!body.ok) return body.response;

    const raw = body.value;
    if (isRecord(raw) && raw.client_id !== undefined && raw.client_id !== clientId) {
      return adminError(c, 400, "invalid_fixture", [
        { path: "client_id", message: `Body client_id differs from the path ${clientId}` },
      ]);
    }
    const parsed = FixtureClient.safeParse(isRecord(raw) ? { ...raw, client_id: clientId } : raw);
    if (!parsed.success) return adminError(c, 400, "invalid_fixture", zodIssues(parsed.error));

    const client = normalizeClient(parsed.data);
    const outcome = await store.upsertClient(client);
    return c.json(client, outcome === "created" ? 201 : 200);
  });

  return admin;
}
