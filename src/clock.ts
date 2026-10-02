// The server's notion of "now", for validity checks only.
// The admin clock offset (`POST /__admin/clock`) moves it forward so a test can expire a code or
// a token without sleeping. Everything the mock emits (`iat`, `auth_time`, record dates) is wall
// time, `Date.now()`, so a client library checking against its own clock still accepts it.
import type { Store } from "./store/types";

/** Epoch milliseconds as the server sees them: wall time plus the admin clock offset. */
export async function serverNowMs(store: Store): Promise<number> {
  return Date.now() + (await store.clockOffsetMs());
}
