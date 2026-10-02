import { Hono } from "hono";
import type { AppEnv } from "../app";

// The admin API lands in the next commit of phase 1 (#4).
export function adminRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
