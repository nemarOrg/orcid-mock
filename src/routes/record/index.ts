import { Hono } from "hono";
import type { AppEnv } from "../../app";

// Phase 4 (#7) fills this router, mounted at /v3.0: /{iD}/record and every section.
export function recordRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
