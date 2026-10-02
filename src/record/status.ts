// The record-state checks every record-scoped read runs before it serves anything, in ORCID's
// order. Bulk works skips them and checks only that the record exists.
import type { StoredUser } from "../store/types";

export type Blocked =
  /** No such iD: 404 / 9016. */
  | { kind: "not-found" }
  /** Merged into `primary`: 301 / 9007 with a `Location` at the primary record. */
  | { kind: "deprecated"; primary: string }
  /** Never claimed: 409 / 9036. */
  | { kind: "unclaimed" }
  /** Locked: 409 / 9018. */
  | { kind: "locked" }
  /** Deactivated: 409 / 9044. */
  | { kind: "deactivated" };

/**
 * ORCID's `checkProfile`: an unknown iD, then a deprecated record, then an unclaimed one, then a
 * locked one, then a deactivated one; the first that applies wins:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/impl/OrcidSecurityManagerImpl.java#L146-L197
 * orcid-mock choice: `claimed: false` is always blocked. ORCID blocks an unclaimed record only
 * while it is younger than its claim wait period (ten days by default), which would make a
 * fixture's behavior depend on when the server started.
 * The iD is not validated, checksum included, on a read (observed: a malformed iD and a
 * checksum-invalid one are both 404 / 9016).
 */
export function blockedBy(user: StoredUser | null): Blocked | null {
  if (user === null) return { kind: "not-found" };
  if (user.deprecated_to !== undefined) return { kind: "deprecated", primary: user.deprecated_to };
  if (user.claimed === false) return { kind: "unclaimed" };
  if (user.locked) return { kind: "locked" };
  if (user.deactivated) return { kind: "deactivated" };
  return null;
}

/**
 * What bulk works checks instead of `blockedBy`: only that the record exists, so a deprecated,
 * unclaimed, locked, or deactivated record is read like any other (observed for a deprecated
 * record, which answered 200 with per-element errors, not a 301; the rest is inferred from the
 * source, where the delegator checks only that the profile exists):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-pub-web/src/main/java/org/orcid/api/publicV3/server/delegator/impl/PublicV3ApiServiceDelegatorImpl.java#L641-L651
 */
export function existsOnly(user: StoredUser | null): Blocked | null {
  return user === null ? { kind: "not-found" } : null;
}
