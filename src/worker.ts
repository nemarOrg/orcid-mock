// A Cloudflare Workers entry for orcid-mock: the real-runtime portability gate from ADR 0002.
//
// This is a SMOKE TEST of portability, not the hosted mode. It proves that the portable layer
// (src/app.ts and everything it imports) bundles with `wrangler deploy --dry-run` without
// `nodejs_compat` and answers requests inside workerd, the runtime Workers use. It serves the
// bundled starter users from memory, one store per isolate, which Cloudflare may recycle or
// duplicate at any time, so state is neither durable nor shared between isolates. The hosted
// mode (MVP2) runs the app inside a Durable Object per tenant instead.
//
// Workers forbid random values, outbound requests, and code generation while a module is being
// evaluated, so nothing here runs at module scope: the store and the app are built on the first
// request. `publicBaseUrl` comes from the `PUBLIC_BASE_URL` binding and nowhere else; deriving
// it from the request's origin would trust the `Host` header, which the architecture forbids.
import type { Hono } from "hono";
import type { AppEnv } from "./app";
import { createMockApp } from "./bootstrap";
import { ConfigError, parsePublicBaseUrl } from "./config";
import { STARTER_USERS_FILE } from "./fixtures/starter";

export interface WorkerEnv {
  /** Absolute http(s) URL of this Worker as callers reach it; set in wrangler.toml or the dashboard. */
  PUBLIC_BASE_URL?: string;
}

// The one deliberate module-level variable in src/: an isolate's single app and store. ADR 0002
// forbids module state in the portable layer proper; this entry is the isolate boundary, and the
// Durable Object entry that replaces it holds the store itself.
let cached: { baseUrl: string; app: Promise<Hono<AppEnv>> } | undefined;

function appFor(baseUrl: string): Promise<Hono<AppEnv>> {
  if (cached?.baseUrl === baseUrl) return cached.app;
  const app = createMockApp({
    users: STARTER_USERS_FILE,
    config: { publicBaseUrl: baseUrl, logLevel: "info" },
    nowMs: Date.now(),
    source: "the bundled starter users",
  }).then((mock) => mock.app);
  // A failed build must not stick: the next request tries again.
  app.catch(() => {
    if (cached?.app === app) cached = undefined;
  });
  cached = { baseUrl, app };
  return app;
}

function misconfigured(message: string): Response {
  return Response.json({ error: "misconfigured", message }, { status: 500 });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const raw = env.PUBLIC_BASE_URL;
    if (raw === undefined || raw === "") {
      return misconfigured(
        "The PUBLIC_BASE_URL binding is not set. Set it to the absolute URL callers use to " +
          "reach this Worker, for example https://orcid-mock.example.workers.dev; orcid-mock " +
          "puts it in every URL it emits and never derives it from the Host header.",
      );
    }
    let baseUrl: string;
    try {
      baseUrl = parsePublicBaseUrl(raw);
    } catch (error) {
      if (error instanceof ConfigError) return misconfigured(error.message);
      throw error;
    }
    return (await appFor(baseUrl)).fetch(request);
  },
};
