// The person-level sections: emails, and (added with their routes) names, addresses, keywords,
// and the rest. Each builder takes the stored user and the viewer and returns the wire object the
// section serves, with filtering and last-modified recomputation already applied.
import type { StoredUser } from "../store/types";
import type { JsonObject } from "./json";
import { canSee, type Viewer } from "./viewer";
import { type Built, maxMs, selfSource, stamp, stampOrNull } from "./wire";

type StoredEmail = NonNullable<StoredUser["emails"]>[number];

/**
 * An email item. Unlike every other item it has `"path": null` and `"put-code": null` (emails
 * have no put-code in ORCID's API) and no `display-index`, and `visibility` comes before
 * `verified` and `primary`; all observed on pub.orcid.org/v3.0 on 2026-10-01.
 */
function emailItem(user: StoredUser, email: StoredEmail, viewer: Viewer): JsonObject {
  return {
    "created-date": stamp(email.created_ms),
    "last-modified-date": stamp(email.modified_ms),
    source: selfSource(user, viewer),
    email: email.email,
    path: null,
    visibility: email.visibility,
    verified: email.verified,
    primary: email.primary,
    "put-code": null,
  };
}

/**
 * The `email` container, `{ last-modified-date, email, path }` (nested as `emails` in a person).
 * Non-public emails are removed, not redacted, and `last-modified-date` is the latest of the
 * survivors, null when none is left, as `calculateLastModified(Emails)` does:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/version/impl/Api3_0LastModifiedDatesHelper.java#L145-L155
 * ORCID's own order is the table's, which has no `order by`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-persistence/src/main/java/org/orcid/persistence/dao/impl/EmailDaoImpl.java#L158-L163
 * so orcid-mock keeps the fixture's order.
 */
export function emails(user: StoredUser, viewer: Viewer): Built {
  const visible = (user.emails ?? []).filter((email) => canSee(viewer, email.visibility));
  const lastMs = maxMs(visible.map((email) => email.modified_ms));
  return {
    json: {
      "last-modified-date": stampOrNull(lastMs),
      email: visible.map((email) => emailItem(user, email, viewer)),
      path: `/${user.orcid}/email`,
    },
    lastMs,
  };
}
