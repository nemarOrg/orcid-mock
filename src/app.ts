// The portable application: everything reachable from here uses Web APIs only, no Bun or Node
// import or global, and does no work at module scope (ADR 0002).
// All mutable state is in `deps.store`; every absolute URL derives from `deps.config`.
import { Hono } from "hono";
import type { CoreConfig } from "./config";
import { adminError, ORCID_API_ERRORS, oauthError, orcidApiError } from "./errors";
import { type Logger, requestLog } from "./log";
import { adminRoutes } from "./routes/admin";
import { oauthRoutes } from "./routes/oauth";
import { oidcRoutes } from "./routes/oidc";
import { recordRoutes } from "./routes/record";
import type { Store } from "./store/types";

export interface AppDeps {
  config: CoreConfig;
  store: Store;
  log: Logger;
}

export type AppEnv = { Variables: { deps: AppDeps } };

/** Which error shape a path answers in: ORCID's record API, OAuth, or the admin API. */
function errorFamily(path: string): "record" | "oauth" | "admin" {
  if (path === "/v3.0" || path.startsWith("/v3.0/")) return "record";
  if (path === "/oauth" || path.startsWith("/oauth/") || path.startsWith("/.well-known/")) {
    return "oauth";
  }
  return "admin";
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use("*", requestLog(deps.log));

  app.route("/__admin", adminRoutes());
  app.route("/oauth", oauthRoutes());
  // Mounted at the root so phase 3 serves /.well-known/openid-configuration, /oauth/jwks, and
  // /oauth/userinfo from one router without editing this file. A router mounted at the root must
  // declare full paths and never use("*") or other wildcard middleware, which would run for every
  // route registered after it, /v3.0/* included.
  app.route("/", oidcRoutes());
  app.route("/v3.0", recordRoutes());

  // Hono's route() drops a sub-app's notFound and onError, so both dispatch by path prefix here.
  app.notFound((c) => {
    switch (errorFamily(c.req.path)) {
      case "record":
        // ORCID answers an unrouted path with 404 and error 9001 and no Content-Type.
        return orcidApiError(c, ORCID_API_ERRORS.unrouted);
      case "oauth":
        // Mock choice: ORCID's behavior on unknown /oauth and /.well-known paths is unobserved.
        return oauthError(c, 404, "invalid_request", "Not found");
      default:
        return adminError(c, 404, "not_found");
    }
  });

  app.onError((err, c) => {
    // The stack goes to the log; the body stays generic.
    deps.log.error("unhandled_error", { method: c.req.method, path: c.req.path, error: err });
    switch (errorFamily(c.req.path)) {
      case "record":
        // 9008 is ORCID's catch-all and its user message is `apiError.9008.userMessage` in
        // ORCID-Source orcid-core/src/main/resources/i18n/api_en.properties; that key has no
        // developerMessage, so the 500 status and the developer message here are orcid-mock's
        // choice (ORCID's wire text for a 9008 is unobserved).
        return orcidApiError(
          c,
          {
            status: 500,
            code: 9008,
            developerMessage: "500 Internal Server Error",
            userMessage: "Something went wrong in ORCID.",
          },
          { contentType: "application/json;charset=UTF-8" },
        );
      case "oauth":
        return oauthError(c, 500, "server_error", "Internal server error");
      default:
        return adminError(c, 500, "internal_error");
    }
  });

  return app;
}
