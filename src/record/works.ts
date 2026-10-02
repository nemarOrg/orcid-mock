// Works: the grouped summaries (`/works`), one full work (`/work/{put-code}`), and the bulk read
// (`/works/{put-code,...}`).
import { ORCID_API_ERRORS, orcidErrorBody } from "../errors";
import type { StoredUser } from "../store/types";
import { groupIdsJson, idsJson } from "./extid";
import { groupItems } from "./groups";
import type { Json, JsonObject } from "./json";
import { byDisplayIndex, compareWorks } from "./order";
import { parseJavaLong } from "./putcode";
import { canSee, type Viewer } from "./viewer";
import {
  type Built,
  fuzzyDate,
  type ItemLookup,
  identifier,
  maxMs,
  selfSource,
  stamp,
  stampOrNull,
  text,
  wrap,
} from "./wire";

type StoredWork = NonNullable<StoredUser["works"]>[number];

/** The work's title object: `title`, `subtitle`, and `translated-title` with its language. */
function titleJson(work: StoredWork): JsonObject {
  return {
    title: { value: work.title },
    subtitle: wrap(work.subtitle),
    "translated-title": work.translated_title
      ? { value: work.translated_title.value, "language-code": work.translated_title.language_code }
      : null,
  };
}

/**
 * A work summary, thirteen keys, `put-code` first (unlike an affiliation's, which follows
 * `source`), and `display-index` a string last (observed on pub.orcid.org/v3.0 on 2026-10-01).
 * Summaries carry no `short-description`, `citation`, `contributors`, `language-code`, or
 * `country`.
 */
function summary(user: StoredUser, viewer: Viewer, work: StoredWork): JsonObject {
  return {
    "put-code": work.put_code,
    "created-date": stamp(work.created_ms),
    "last-modified-date": stamp(work.modified_ms),
    source: selfSource(user, viewer),
    title: titleJson(work),
    "external-ids": idsJson(work.external_ids, "normalized"),
    url: wrap(work.url),
    type: work.type,
    "publication-date": fuzzyDate(work.publication_date),
    "journal-title": wrap(work.journal_title),
    visibility: work.visibility,
    path: `/${user.orcid}/work/${work.put_code}`,
    "display-index": String(work.display_index ?? 0),
  };
}

/**
 * `/works`: the visible works, grouped by external id among themselves, each group's summaries
 * ordered by display index (highest first, the preferred summary) then creation date (oldest
 * first), and the groups ordered by their preferred summary: publication date newest first, then
 * title, then type. `processGroupedWorks`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/WorkManagerReadOnlyImpl.java#L563-L593
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/utils/v3/activities/WorkComparators.java#L55-L65
 * The public delegator groups the public works only (`groupWorks(works, true)`), then filters,
 * then recomputes every date from what is left:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-pub-web/src/main/java/org/orcid/api/publicV3/server/delegator/impl/PublicV3ApiServiceDelegatorImpl.java#L255-L280
 * Each group is `{ last-modified-date, external-ids, work-summary }`, the summary array holding
 * summaries directly (an affiliation's holds one-key wrappers). The works arrive in the fixture's
 * order, which ORCID leaves to its database.
 */
export function works(user: StoredUser, viewer: Viewer): Built {
  const visible = (user.works ?? []).filter((work) => canSee(viewer, work.visibility));
  const groups = groupItems(visible, (work) => work.external_ids, "normalized")
    .map((group) => ({
      keys: group.keys,
      // `byDisplayIndex` is stable, so the creation-date tie-break is a second stable sort first.
      members: byDisplayIndex([...group.members].sort((a, b) => a.created_ms - b.created_ms)),
    }))
    .sort((a, b) => compareWorks(a.members[0] as StoredWork, b.members[0] as StoredWork));
  const built = groups.map((group) => {
    const lastMs = maxMs(group.members.map((work) => work.modified_ms));
    return {
      lastMs,
      json: {
        "last-modified-date": stampOrNull(lastMs),
        "external-ids": groupIdsJson(group.keys, "normalized"),
        "work-summary": group.members.map((work) => summary(user, viewer, work)),
      },
    };
  });
  const lastMs = maxMs(built.map((group) => group.lastMs));
  return {
    json: {
      "last-modified-date": stampOrNull(lastMs),
      group: built.map((group) => group.json),
      path: `/${user.orcid}/works`,
    },
    lastMs,
  };
}

/** A contributor: the credit name is `{ value }`, and the email is never served. */
function contributorJson(
  viewer: Viewer,
  contributor: NonNullable<StoredWork["contributors"]>[number],
): JsonObject {
  const hasAttributes =
    contributor.contributor_sequence != null || contributor.contributor_role != null;
  return {
    "contributor-orcid": contributor.contributor_orcid
      ? identifier(viewer.baseUrl, contributor.contributor_orcid)
      : null,
    "credit-name": { value: contributor.credit_name },
    "contributor-email": null,
    "contributor-attributes": hasAttributes
      ? {
          "contributor-sequence": contributor.contributor_sequence ?? null,
          "contributor-role": text(contributor.contributor_role),
        }
      : null,
  };
}

/**
 * The full work, seventeen keys (observed): `put-code` and `path` right after `source`, no
 * `display-index`, and `visibility` last. Absent optional parts are null: `citation`,
 * `contributors`, `short-description`, `language-code`, `country`, `journal-title`, `url`.
 */
function full(user: StoredUser, viewer: Viewer, work: StoredWork): JsonObject {
  return {
    "created-date": stamp(work.created_ms),
    "last-modified-date": stamp(work.modified_ms),
    source: selfSource(user, viewer),
    "put-code": work.put_code,
    path: `/${user.orcid}/work/${work.put_code}`,
    title: titleJson(work),
    "journal-title": wrap(work.journal_title),
    "short-description": text(work.short_description),
    citation: work.citation
      ? {
          "citation-type": work.citation.citation_type,
          "citation-value": work.citation.citation_value,
        }
      : null,
    type: work.type,
    "publication-date": fuzzyDate(work.publication_date),
    "external-ids": idsJson(work.external_ids, "normalized"),
    url: wrap(work.url),
    contributors:
      work.contributors && work.contributors.length > 0
        ? { contributor: work.contributors.map((c) => contributorJson(viewer, c)) }
        : null,
    "language-code": text(work.language_code),
    country: wrap(work.country),
    visibility: work.visibility,
  };
}

/**
 * `/work/{put-code}`: the work if it is the viewer's to see (`viewWork` calls `checkIsPublic`),
 * `hidden` if it exists but is not, `missing` if it is not this record's:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-pub-web/src/main/java/org/orcid/api/publicV3/server/delegator/impl/PublicV3ApiServiceDelegatorImpl.java#L245-L253
 */
export function workItem(user: StoredUser, viewer: Viewer, putCode: number): ItemLookup {
  const work = (user.works ?? []).find((candidate) => candidate.put_code === putCode);
  if (work === undefined) return { kind: "missing" };
  if (!canSee(viewer, work.visibility)) return { kind: "hidden" };
  return { kind: "ok", json: full(user, viewer, work) };
}

/** The most put-codes one bulk read accepts: `maxWorksToRead`, observed as 100. */
export const MAX_BULK_PUT_CODES = 100;

/**
 * Java's `String.split(",")`: empty strings at the end are dropped, so a trailing comma is
 * ignored (observed: `works/9543020,` is the one work) while an empty string in the middle stays
 * and fails to parse (observed: `9543020,,19980729` is 400 / 9006).
 */
function javaSplit(raw: string): string[] {
  const parts = raw.split(",");
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  // A string of nothing but commas splits to no elements at all.
  return parts.length === 1 && parts[0] === "" && raw !== "" ? [] : parts;
}

export type BulkResult =
  /** More than 100 put-codes: 400 / 9042. */
  | { kind: "too-many" }
  /** An element that is not a number: 400 / 9006 with that element in the message. */
  | { kind: "bad-element"; raw: string }
  | { kind: "ok"; body: Json };

/**
 * `/works/{put-code,...}`: each requested work in full, wrapped `{ "work": ... }`, in
 * ascending put-code order (observed: a request for `19980729,9543020` came back as 9543020
 * then 19980729, so the database's order, not the request's); a work the viewer may not see is
 * an `{ "error": <9039> }` in its place; then, after every work, an `{ "error": <9034> }` for
 * each requested put-code that was not found: unknown, another record's, or a repeat (observed:
 * a put-code requested twice is a work and then an error, and `007` reads as 7). The count is
 * checked before any element is parsed, and a bad element fails the whole request. `clientName`
 * fills the `${clientName}` placeholder in 9034 for a reader who has a client, and stays literal
 * for an anonymous one (observed):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/WorkManagerReadOnlyImpl.java#L383-L408
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/publicV3/server/security/impl/PublicAPISecurityManagerV3Impl.java#L253-L275
 */
export function bulkWorks(
  user: StoredUser,
  viewer: Viewer,
  rawCodes: string,
  clientName: string | null,
): BulkResult {
  const parts = javaSplit(rawCodes);
  if (parts.length > MAX_BULK_PUT_CODES) return { kind: "too-many" };
  const requested: bigint[] = [];
  for (const part of parts) {
    const value = parseJavaLong(part);
    if (value === null) return { kind: "bad-element", raw: part };
    requested.push(value);
  }

  const wanted = new Set(requested);
  const found = (user.works ?? [])
    .filter((work) => wanted.has(BigInt(work.put_code)))
    .sort((a, b) => a.put_code - b.put_code);

  const elements: Json[] = found.map(
    (work): Json =>
      canSee(viewer, work.visibility)
        ? { work: full(user, viewer, work) }
        : { error: orcidErrorBody(ORCID_API_ERRORS.notPublic) },
  );
  // Each found work removes the first occurrence of its put-code from the request; what is left
  // was not found, and is reported in the order it was asked for.
  const remaining = [...requested];
  for (const work of found) {
    const at = remaining.indexOf(BigInt(work.put_code));
    if (at !== -1) remaining.splice(at, 1);
  }
  for (const putCode of remaining) {
    elements.push({
      error: orcidErrorBody(ORCID_API_ERRORS.invalidPutCode(putCode.toString(), clientName)),
    });
  }
  return { kind: "ok", body: { bulk: elements } };
}
