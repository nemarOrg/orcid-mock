// Which service the conformance suite talks to, read from the environment.
//
//   CONFORMANCE_TARGET   "mock" or "sandbox"
//   ORCID_API_BASE       the OAuth host (https://sandbox.orcid.org, or the mock's base URL)
//   ORCID_PUB_API_BASE   the record API host (https://pub.sandbox.orcid.org; the same base for the mock)
//   ORCID_CLIENT_ID      a registered client
//   ORCID_CLIENT_SECRET  its secret
//   ORCID_PUBLIC_ID      an iD whose record is public and whose name is public
//
// and optionally
//
//   CONFORMANCE_ANONYMOUS_ONLY=1  run only the cases that need no registered client, skip the
//                                 others with a message, and leave the two client variables out
//   CONFORMANCE_REQUIRE_ITEMS=1   fail a run whose works, employments, or email are empty, so a
//                                 record with nothing in it cannot pass as full coverage
//   CONFORMANCE_DELAY_MS          the least time between two requests, in milliseconds (the
//                                 defaults are 400 for the sandbox and 0 for the mock)
//
// A missing or malformed variable stops the run with one message that names it; no message here
// ever contains a variable's value, because two of them are credentials.

export type TargetName = "mock" | "sandbox";

export interface Target {
  name: TargetName;
  /** The OAuth host, without a trailing slash. */
  apiBase: string;
  /** The record API host, without a trailing slash. */
  pubApiBase: string;
  /** Unregistered (`PLACEHOLDER_CLIENT_ID`) when the run is anonymous-only and none was given. */
  clientId: string;
  /** Empty when the run is anonymous-only and none was given. */
  clientSecret: string;
  publicId: string;
  /** Only the cases that need no registered client run. */
  anonymousOnly: boolean;
  /** An empty works, employments, or email container fails the run. */
  requireItems: boolean;
  /** The least time between two requests, so a run stays far below ORCID's anonymous limits. */
  requestDelayMs: number;
}

/**
 * The client id an anonymous-only run uses for the one case that needs a client id and no
 * registered client: a token request with a wrong secret, which is refused whoever the client is.
 */
export const PLACEHOLDER_CLIENT_ID = "APP-0000000000000000";

const ALWAYS_REQUIRED = [
  "CONFORMANCE_TARGET",
  "ORCID_API_BASE",
  "ORCID_PUB_API_BASE",
  "ORCID_PUBLIC_ID",
] as const;
const CLIENT_REQUIRED = ["ORCID_CLIENT_ID", "ORCID_CLIENT_SECRET"] as const;

/** ORCID allows 12 anonymous requests a second; one every 400 ms is about a fifth of that. */
const SANDBOX_DELAY_MS = 400;
const MAX_DELAY_MS = 60_000;

const ORCID_ID_SHAPE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

type Env = Record<string, string | undefined>;

function httpBase(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http or https URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an absolute http or https URL.`);
  }
  return value.replace(/\/+$/, "");
}

/** A switch is `1` or unset; anything else is refused, so `true` or `yes` is never misread. */
function flag(env: Env, name: string): boolean {
  const value = (env[name] ?? "").trim();
  if (value === "") return false;
  if (value !== "1") throw new Error(`${name} must be 1 or unset.`);
  return true;
}

function delayMs(raw: string | undefined, fallback: number): number {
  const value = (raw ?? "").trim();
  if (value === "") return fallback;
  const delay = Number(value);
  if (!/^\d+$/.test(value) || delay > MAX_DELAY_MS) {
    throw new Error(
      `CONFORMANCE_DELAY_MS must be a whole number of milliseconds, at most ${MAX_DELAY_MS}.`,
    );
  }
  return delay;
}

/** Reads and validates the target from `env`; throws one error that names what is wrong. */
export function loadTarget(env: Env = process.env): Target {
  const anonymousOnly = flag(env, "CONFORMANCE_ANONYMOUS_ONLY");
  const required = anonymousOnly ? ALWAYS_REQUIRED : [...ALWAYS_REQUIRED, ...CLIENT_REQUIRED];
  const read = (name: string): string => (env[name] ?? "").trim();

  const missing = required.filter((name) => read(name) === "");
  if (missing.length > 0) {
    throw new Error(
      `The conformance target is not configured: set ${missing.join(", ")}. ` +
        "See the Conformance section of the README.",
    );
  }

  const name = read("CONFORMANCE_TARGET");
  if (name !== "mock" && name !== "sandbox") {
    throw new Error('CONFORMANCE_TARGET must be "mock" or "sandbox".');
  }
  const publicId = read("ORCID_PUBLIC_ID");
  if (!ORCID_ID_SHAPE.test(publicId)) {
    throw new Error("ORCID_PUBLIC_ID must be an ORCID iD such as 0000-0002-1825-0097.");
  }
  return {
    name,
    apiBase: httpBase("ORCID_API_BASE", read("ORCID_API_BASE")),
    pubApiBase: httpBase("ORCID_PUB_API_BASE", read("ORCID_PUB_API_BASE")),
    clientId: read("ORCID_CLIENT_ID") || PLACEHOLDER_CLIENT_ID,
    clientSecret: read("ORCID_CLIENT_SECRET"),
    publicId,
    anonymousOnly,
    requireItems: flag(env, "CONFORMANCE_REQUIRE_ITEMS"),
    requestDelayMs: delayMs(env.CONFORMANCE_DELAY_MS, name === "sandbox" ? SANDBOX_DELAY_MS : 0),
  };
}
