// `/{iD}` and `/{iD}/record`: the whole record, composed from the section builders.
import type { StoredUser } from "../store/types";
import { activities } from "./activities";
import type { JsonObject } from "./json";
import { person } from "./person";
import type { Viewer } from "./viewer";
import { identifier, maxMs, stamp } from "./wire";

/** The latest `modified_ms` anywhere in the record, hidden items included. */
function lastEdit(user: StoredUser): number {
  const times = [
    user.name.modified_ms,
    user.biography?.modified_ms,
    ...(user.emails ?? []).map((email) => email.modified_ms),
  ];
  for (const items of [
    user.other_names,
    user.addresses,
    user.keywords,
    user.external_identifiers,
    user.researcher_urls,
    user.employments,
    user.educations,
    user.qualifications,
    user.works,
    user.fundings,
    user.peer_reviews,
  ]) {
    for (const item of items ?? []) times.push(item.modified_ms);
  }
  return maxMs(times) ?? user.name.modified_ms;
}

/**
 * The `history` object, nine keys. orcid-mock choices, since a fixture has no history of its own:
 * every record is `WEBSITE`-created with no `completion-date`, `source`, or `deactivation-date`;
 * `submission-date` is when the name was created; `last-modified-date` is the latest
 * modification of anything in the record, hidden items included, since ORCID's is the record's
 * own last edit and is independent of the sections' dates (observed). `claimed` comes from the
 * fixture. `verified-email` and `verified-primary-email` look at every email whatever its
 * visibility, as ORCID's do (observed: a record whose only email was private had both true).
 */
export function history(user: StoredUser): JsonObject {
  const mail = user.emails ?? [];
  return {
    "creation-method": "WEBSITE",
    "completion-date": null,
    "submission-date": stamp(user.name.created_ms),
    "last-modified-date": stamp(lastEdit(user)),
    claimed: user.claimed ?? true,
    source: null,
    "deactivation-date": null,
    "verified-email": mail.some((email) => email.verified),
    "verified-primary-email": mail.some((email) => email.primary && email.verified),
  };
}

/**
 * The record: `orcid-identifier`, `preferences`, `history`, `person`, `activities-summary`, and
 * `path`, which is `/{iD}` and not `/{iD}/record` (observed). `person` and `activities-summary`
 * are the same objects `/person` and `/activities` serve.
 */
export function record(user: StoredUser, viewer: Viewer): JsonObject {
  return {
    "orcid-identifier": identifier(viewer.baseUrl, user.orcid),
    // orcid-mock choice: ORCID's `en` is the locale of most records; a fixture has no locale.
    preferences: { locale: "en" },
    history: history(user),
    person: person(user, viewer).json,
    "activities-summary": activities(user, viewer).json,
    path: `/${user.orcid}`,
  };
}
