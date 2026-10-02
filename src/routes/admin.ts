// The admin API: reset, health, and the users and clients an app under test needs to register.
// Unauthenticated by design (the server binds 127.0.0.1 by default) and without CORS.
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
import { ClockRangeError } from "../store/types";

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

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// `host` or `[ipv6]`, then an optional `:port`; nothing else (no userinfo, path, or list).
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[^\s:[\]/?#@\\,]+)(?::[0-9]*)?$/i;

/**
 * The hostname of a `Host` header value, lowercased, or null when the value is not a host and an
 * optional port. A bare `::1` has no port to strip, so it is its own hostname.
 */
function hostnameOf(host: string | undefined): string | null {
  if (host === undefined) return null;
  if (host === "::1") return host;
  const match = HOST_HEADER.exec(host);
  return match?.[1] === undefined ? null : match[1].toLowerCase();
}

export function adminRoutes(): Hono<AppEnv> {
  const admin = new Hono<AppEnv>();

  // orcid-mock's own rules, not ORCID's: the admin API has no authentication, so a web page must
  // not be able to reset, rewrite, or read a local mock.
  // The `Origin` rule: browsers always send `Origin` on a cross-origin request, and curl and test
  // clients send none, so refusing a foreign `Origin` closes the hole without getting in the way
  // of either.
  // The `Host` rule: a DNS-rebinding page is same-origin to the browser, which sends no `Origin`
  // on a GET, so the rule above lets it read every user. Its `Host` is the attacker's name,
  // though, so only a loopback name or the hostname of PUBLIC_BASE_URL (what callers outside this
  // machine, such as another container, use to reach the mock) is served. Fail closed: a missing
  // or malformed `Host` is refused.
  // One exemption from the `Host` rule: `GET /__admin/health`, which reveals two counts, so an
  // orchestrator's probe that sends `Host: <pod-ip>:9700` works; the `Origin` rule still applies.
  admin.use("*", async (c, next) => {
    const base = new URL(c.get("deps").config.publicBaseUrl);
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== base.origin) {
      return adminError(c, 403, "forbidden_origin");
    }
    if (c.req.method === "GET" && c.req.path === "/__admin/health") return next();
    const hostname = hostnameOf(c.req.header("host"));
    if (hostname === null || !(LOOPBACK_HOSTNAMES.has(hostname) || hostname === base.hostname)) {
      return adminError(c, 403, "forbidden_host");
    }
    await next();
  });

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

  // Moves the server's clock forward so a test can expire a code or a token without sleeping.
  // The offset only governs validity checks; emitted timestamps stay wall time (src/clock.ts).
  // `reset` zeroes it. orcid-mock's own endpoint, with no ORCID counterpart.
  admin.post("/clock", async (c) => {
    const { store } = c.get("deps");
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const seconds = isRecord(body.value) ? body.value.advance_seconds : undefined;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      return adminError(c, 400, "invalid_request", [
        { path: "advance_seconds", message: "Expected a finite, non-negative number of seconds" },
      ]);
    }
    try {
      return c.json({ offset_ms: await store.advanceClock(seconds) });
    } catch (error) {
      // An advance that would carry the clock past the end of the Date range.
      if (error instanceof ClockRangeError) {
        return adminError(c, 400, "invalid_request", [
          { path: "advance_seconds", message: error.message },
        ]);
      }
      throw error;
    }
  });

  admin.get("/clients", async (c) => c.json(await c.get("deps").store.listClients()));

  admin.get("/clients/:client_id", async (c) => {
    const client = await c.get("deps").store.getClient(c.req.param("client_id"));
    return client ? c.json(client) : adminError(c, 404, "not_found");
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
