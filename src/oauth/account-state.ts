// The one rule for a user whose record is locked or deactivated: sign-in, the authorization-code
// exchange, the refresh grant, and userinfo all refuse such a user (ADR 0009). The record API has
// its own, older answer (409, in ORCID's order: src/record/status.ts).
import type { StoredUser } from "../store/types";

export type AccountState = "deactivated" | "locked";

/**
 * Why a user may not sign in or use a token, or null. orcid-mock choice: real ORCID refuses a
 * locked or deactivated record's sign-in, but how it treats a token already issued is
 * unobserved, so the mock stops every way of using one at the moment of use, which is what an
 * admin who locks a user mid-flow expects to see.
 */
export function accountState(user: StoredUser): AccountState | null {
  if (user.deactivated) return "deactivated";
  if (user.locked) return "locked";
  return null;
}

/** The `invalid_grant` description for a user the token grants refuse, or null. */
export function grantRefusal(user: StoredUser): string | null {
  const state = accountState(user);
  return state === null ? null : `iD ${user.orcid} is ${state} and cannot receive a token`;
}
