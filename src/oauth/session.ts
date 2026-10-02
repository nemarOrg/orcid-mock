// The browser session that lets `prompt=none` sign a user in silently.
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import { serverNowMs } from "../clock";
import type { Session } from "../store/types";

export const SESSION_COOKIE = "orcid_mock_session";

/** orcid-mock choice: ORCID's session lifetime is not documented. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** The session the request's cookie names, if it exists and has not expired at server time. */
export async function currentSession(c: Context<AppEnv>): Promise<Session | null> {
  const id = getCookie(c, SESSION_COOKIE);
  if (id === undefined || id === "") return null;
  const { store } = c.get("deps");
  const session = await store.getSession(id);
  if (!session) return null;
  if ((await serverNowMs(store)) >= session.expires_at_ms) {
    await store.deleteSession(id);
    return null;
  }
  return session;
}

/** Signs `orcid` in: stores a session, replaces the one the request carried, sets the cookie. */
export async function startSession(
  c: Context<AppEnv>,
  orcid: string,
  authTimeMs: number,
): Promise<Session> {
  const { store } = c.get("deps");
  const previous = getCookie(c, SESSION_COOKIE);
  if (previous !== undefined && previous !== "") await store.deleteSession(previous);
  const session: Session = {
    id: crypto.randomUUID(),
    orcid,
    auth_time_ms: authTimeMs,
    expires_at_ms: (await serverNowMs(store)) + SESSION_TTL_MS,
  };
  await store.putSession(session);
  setCookie(c, SESSION_COOKIE, session.id, { httpOnly: true, sameSite: "Lax", path: "/" });
  return session;
}
