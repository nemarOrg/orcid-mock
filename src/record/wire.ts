// The small wire objects every section shares: timestamps, `{ value }` wrappers, identifiers,
// sources, dates, and organizations. Key order is ORCID's, observed on pub.orcid.org/v3.0 on
// 2026-10-01.
import type { FixtureOrganization } from "../fixtures/schema";
import { publicDisplayName } from "../oauth/display-name";
import type { StoredUser } from "../store/types";
import type { Json, JsonObject } from "./json";
import type { Viewer } from "./viewer";

/** A built section: its wire form and the latest `modified_ms` among what survived filtering. */
export interface Built<T extends Json = JsonObject> {
  json: T;
  lastMs: number | null;
}

/**
 * The answer to a single-item read: the item as the viewer sees it, or why there is none. An
 * item the viewer may not see is `hidden` (403 / 9039), not `missing` (404 / 9016), because it
 * exists.
 */
export type ItemLookup =
  | { kind: "ok"; json: JsonObject }
  | { kind: "hidden" }
  | { kind: "missing" };

/** The latest of the given times, ignoring nulls; null when there is none. */
export function maxMs(values: Iterable<number | null | undefined>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value !== null && value !== undefined && (latest === null || value > latest)) {
      latest = value;
    }
  }
  return latest;
}

/** `created-date`, `last-modified-date`, and the like: `{ "value": epoch milliseconds }`. */
export function stamp(ms: number): JsonObject {
  return { value: ms };
}

/** A container's `last-modified-date`: a stamp, or null when nothing survived. */
export function stampOrNull(ms: number | null): JsonObject | null {
  return ms === null ? null : stamp(ms);
}

/** True for null, undefined, and a string of whitespace, which ORCID treats as absent. */
export function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/** A string, or null when it is blank. */
export function text(value: string | null | undefined): string | null {
  return isBlank(value) ? null : (value as string);
}

/** `{ "value": ... }` for a value that has one, null for a blank. */
export function wrap(value: string | null | undefined): JsonObject | null {
  return isBlank(value) ? null : { value: value as string };
}

/** The host a `PUBLIC_BASE_URL` names, port included (orcid-mock choice, see `identifier`). */
function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

/**
 * `{ uri, path, host }` for an iD: `uri` is `PUBLIC_BASE_URL/<iD>` and `host` is that URL's host.
 * orcid-mock choice: real ORCID writes `https://orcid.org/<iD>` and `orcid.org` (observed on
 * pub.orcid.org on 2026-10-01), but every absolute URL here derives from `PUBLIC_BASE_URL`
 * (ADR 0001). `host` keeps the port, so `host` and `path` rebuild the `uri` when the base URL has
 * no path prefix.
 */
export function identifier(baseUrl: string, orcid: string): JsonObject {
  return { uri: `${baseUrl}/${orcid}`, path: orcid, host: hostOf(baseUrl) };
}

/**
 * The `source` of an item, always six keys. orcid-mock choice: every item is self-asserted, so
 * `source-orcid` is the user and `source-client-id` is null (ORCID writes a client there for an
 * item a member added); `source-name` is the user's public display name, as ORCID fills it from
 * the current name at read time, and null when the name is not public; the three
 * `assertion-origin-*` keys are null, as for any item that was not added on someone's behalf.
 */
export function selfSource(user: StoredUser, viewer: Viewer): JsonObject {
  const name = publicDisplayName(user);
  return {
    "source-orcid": identifier(viewer.baseUrl, user.orcid),
    "source-client-id": null,
    "source-name": name === "" ? null : { value: name },
    "assertion-origin-orcid": null,
    "assertion-origin-client-id": null,
    "assertion-origin-name": null,
  };
}

/**
 * A fixture date (`YYYY`, `YYYY-MM`, or `YYYY-MM-DD`) as ORCID's fuzzy date: each part is
 * `{ "value": "..." }` with a zero-padded month and day, and a missing part is null. An absent
 * date is null.
 */
export function fuzzyDate(date: string | null | undefined): JsonObject | null {
  if (isBlank(date)) return null;
  const [year, month, day] = (date as string).split("-");
  return { year: wrap(year), month: wrap(month), day: wrap(day) };
}

/** An organization as ORCID writes it; `region` and `disambiguated-organization` may be null. */
export function organization(org: FixtureOrganization): JsonObject {
  const disambiguated = org.disambiguated_organization;
  return {
    name: org.name,
    address: {
      city: org.address.city,
      region: text(org.address.region),
      country: org.address.country,
    },
    "disambiguated-organization": disambiguated
      ? {
          "disambiguated-organization-identifier":
            disambiguated.disambiguated_organization_identifier,
          "disambiguation-source": disambiguated.disambiguation_source,
        }
      : null,
  };
}
