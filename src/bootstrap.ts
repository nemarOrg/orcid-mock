// The portable composition root: a users file in, a mock app and its store out.
// server.ts uses it, and so will the Worker entry, so both build the app the same way.
import type { Hono } from "hono";
import { type AppEnv, createApp } from "./app";
import type { CoreConfig } from "./config";
import { FixtureError, parseUsersFile } from "./fixtures/load";
import { createLogger, type Logger } from "./log";
import { MemoryStore } from "./store/memory";
import type { Store } from "./store/types";

export interface MockOptions {
  /** A users file already parsed from JSON. */
  users: unknown;
  /**
   * Kept by reference, not copied: a caller that learns its bound address after building the app
   * may set `publicBaseUrl` afterwards, and the app reads it on every request.
   */
  config: CoreConfig;
  /** Stamped on every dated item; the caller's clock, so this stays free of I/O. */
  nowMs: number;
  /** Defaults to a logger at `config.logLevel`. */
  log?: Logger;
  /** What the users came from, for the error message (a file path, say). */
  source?: string;
}

/** Validates the users, loads them into a fresh MemoryStore as its baseline, and builds the app. */
export async function createMockApp(
  opts: MockOptions,
): Promise<{ app: Hono<AppEnv>; store: Store }> {
  const loaded = parseUsersFile(opts.users, opts.nowMs);
  if (!loaded.ok) throw new FixtureError(loaded.issues, opts.source);
  const store = new MemoryStore();
  await store.setBaseline(loaded.snapshot);
  const app = createApp({
    config: opts.config,
    store,
    log: opts.log ?? createLogger(opts.config.logLevel),
  });
  return { app, store };
}
