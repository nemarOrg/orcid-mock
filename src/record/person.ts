// The person-level sections: the name, the biography, emails, and the five lists of items that
// carry a put-code (other names, keywords, researcher URLs, external identifiers, addresses),
// then `personal-details` and `person`, which compose them. Each builder takes the stored user
// and the viewer and returns the wire object the section serves, with filtering and
// last-modified recomputation already applied.
//
// Everything non-public is removed, not redacted; `name` and `biography` become null; and every
// container's `last-modified-date` is recomputed from what survives, so none leaks the date of a
// hidden item (`PublicAPISecurityManagerV3Impl.filter(Person)`, then
// `Api3_0LastModifiedDatesHelper.calculateLastModified(Person)`):
// https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/publicV3/server/security/impl/PublicAPISecurityManagerV3Impl.java#L297-L344
// https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/version/impl/Api3_0LastModifiedDatesHelper.java#L243-L262
import type { StoredUser, Visibility } from "../store/types";
import type { JsonObject } from "./json";
import { displayOrder } from "./order";
import { canSee, type Viewer } from "./viewer";
import {
  type Built,
  type ItemLookup,
  maxMs,
  selfSource,
  stamp,
  stampOrNull,
  text,
  wrap,
} from "./wire";

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
 * ORCID's own order is the table's, which has no `order by`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-persistence/src/main/java/org/orcid/persistence/dao/impl/EmailDaoImpl.java#L158-L163
 * so orcid-mock keeps the fixture's order. `calculateLastModified(Emails)` sets a date only when
 * an email survives, so a record whose only emails are hidden has a null date (observed):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/version/impl/Api3_0LastModifiedDatesHelper.java#L145-L155
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

/**
 * The name, or null when the viewer may not see it (observed: a private name is `"name": null`
 * in `/person`, `/personal-details`, and `/record`). `source` is null on a name, `path` is the
 * bare iD, and there is no put-code or display index. A missing family or credit name is null.
 */
export function name(user: StoredUser, viewer: Viewer): Built | null {
  const { name: stored } = user;
  if (!canSee(viewer, stored.visibility)) return null;
  return {
    json: {
      "created-date": stamp(stored.created_ms),
      "last-modified-date": stamp(stored.modified_ms),
      "given-names": { value: stored.given_names },
      "family-name": wrap(stored.family_name),
      "credit-name": wrap(stored.credit_name),
      source: null,
      visibility: stored.visibility,
      path: user.orcid,
    },
    lastMs: stored.modified_ms,
  };
}

export type BiographyView =
  /** No biography at all: `/biography` is 404 / 9041, and `person` shows null. */
  | { state: "absent" }
  /** A biography the viewer may not see: `/biography` is 403 / 9039, and `person` shows null. */
  | { state: "hidden" }
  | { state: "visible"; built: Built };

/**
 * The biography: `content` is a plain string (not `{ value }`), and there is no `source`, put-code,
 * or display index (observed). `PublicAPISecurityManagerV3Impl.checkIsPublic(Biography)` throws
 * `OrcidNoBioException` (404 / 9041) for none and `OrcidNonPublicElementException` (403 / 9039)
 * for one that is not public:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/publicV3/server/security/impl/PublicAPISecurityManagerV3Impl.java#L55-L67
 */
export function biography(user: StoredUser, viewer: Viewer): BiographyView {
  const stored = user.biography;
  if (stored === undefined || stored === null) return { state: "absent" };
  if (!canSee(viewer, stored.visibility)) return { state: "hidden" };
  return {
    state: "visible",
    built: {
      json: {
        "created-date": stamp(stored.created_ms),
        "last-modified-date": stamp(stored.modified_ms),
        content: stored.content,
        visibility: stored.visibility,
        path: `/${user.orcid}/biography`,
      },
      lastMs: stored.modified_ms,
    },
  };
}

interface PersonItem {
  put_code: number;
  created_ms: number;
  modified_ms: number;
  visibility: Visibility;
  display_index?: number | undefined;
}

/** One list of put-coded person-level items: where it lives and what its items add. */
interface PersonSection<T extends PersonItem> {
  /** The array key in the container, singular (`other-name`). */
  key: string;
  /** The path segment: plural for most (`other-names`), `address` for addresses. */
  segment: string;
  list(user: StoredUser): readonly T[] | undefined;
  /** The keys between `source` and `visibility`. */
  fields(item: T): JsonObject;
}

/**
 * A person-level item: `created-date`, `last-modified-date`, `source`, the section's own fields,
 * `visibility`, `path`, `put-code`, then `display-index` as a JSON number (it is a string on
 * activity summaries). The path uses the plural collection name (observed).
 */
function personItem<T extends PersonItem>(
  section: PersonSection<T>,
  user: StoredUser,
  viewer: Viewer,
  item: T,
): JsonObject {
  return {
    "created-date": stamp(item.created_ms),
    "last-modified-date": stamp(item.modified_ms),
    source: selfSource(user, viewer),
    ...section.fields(item),
    visibility: item.visibility,
    path: `/${user.orcid}/${section.segment}/${item.put_code}`,
    "put-code": item.put_code,
    "display-index": item.display_index ?? 0,
  };
}

/** The container: visible items in display order, `{ last-modified-date, <key>, path }`. */
function personContainer<T extends PersonItem & { created_ms: number }>(
  section: PersonSection<T>,
  user: StoredUser,
  viewer: Viewer,
): Built {
  const visible = displayOrder(
    (section.list(user) ?? []).filter((item) => canSee(viewer, item.visibility)),
  );
  const lastMs = maxMs(visible.map((item) => item.modified_ms));
  return {
    json: {
      "last-modified-date": stampOrNull(lastMs),
      [section.key]: visible.map((item) => personItem(section, user, viewer, item)),
      path: `/${user.orcid}/${section.segment}`,
    },
    lastMs,
  };
}

/**
 * One item by put-code. A put-code that is not in this section of this record is `missing`
 * (404 / 9016); one the viewer may not see is `hidden` (403 / 9039, from `checkIsPublic`).
 */
function personLookup<T extends PersonItem>(
  section: PersonSection<T>,
  user: StoredUser,
  viewer: Viewer,
  putCode: number,
): ItemLookup {
  const item = (section.list(user) ?? []).find((candidate) => candidate.put_code === putCode);
  if (item === undefined) return { kind: "missing" };
  if (!canSee(viewer, item.visibility)) return { kind: "hidden" };
  return { kind: "ok", json: personItem(section, user, viewer, item) };
}

type Section = {
  container(user: StoredUser, viewer: Viewer): Built;
  item(user: StoredUser, viewer: Viewer, putCode: number): ItemLookup;
};

function makeSection<T extends PersonItem>(config: PersonSection<T>): Section {
  return {
    container: (user, viewer) => personContainer(config, user, viewer),
    item: (user, viewer, putCode) => personLookup(config, user, viewer, putCode),
  };
}

type StoredOf<K extends keyof StoredUser> =
  NonNullable<StoredUser[K]> extends readonly (infer T)[] ? T : never;

export const otherNames = makeSection<StoredOf<"other_names"> & PersonItem>({
  key: "other-name",
  segment: "other-names",
  list: (user) => user.other_names,
  fields: (item) => ({ content: item.content }),
});

export const keywords = makeSection<StoredOf<"keywords"> & PersonItem>({
  key: "keyword",
  segment: "keywords",
  list: (user) => user.keywords,
  fields: (item) => ({ content: item.content }),
});

export const researcherUrls = makeSection<StoredOf<"researcher_urls"> & PersonItem>({
  key: "researcher-url",
  segment: "researcher-urls",
  list: (user) => user.researcher_urls,
  fields: (item) => ({ "url-name": text(item.url_name), url: { value: item.url } }),
});

/**
 * Person-level external identifiers use the `external-id-*` keys but, unlike the ids on a work or
 * funding, carry no `external-id-normalized` keys (observed).
 */
export const externalIdentifiers = makeSection<StoredOf<"external_identifiers"> & PersonItem>({
  key: "external-identifier",
  segment: "external-identifiers",
  list: (user) => user.external_identifiers,
  fields: (item) => ({
    "external-id-type": item.external_id_type,
    "external-id-value": item.external_id_value,
    "external-id-url": wrap(item.external_id_url),
    "external-id-relationship": item.external_id_relationship ?? null,
  }),
});

/** An address carries only a country code, as `{ "value": "NZ" }` (observed). */
export const addresses = makeSection<StoredOf<"addresses"> & PersonItem>({
  key: "address",
  segment: "address",
  list: (user) => user.addresses,
  fields: (item) => ({ country: { value: item.country } }),
});

/**
 * `/personal-details`: the name, the other names, and the biography, with `last-modified-date`
 * the latest of those three that survive filtering (observed to equal the name's on a record
 * whose name was its latest edit):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/version/impl/Api3_0LastModifiedDatesHelper.java#L232-L241
 */
export function personalDetails(user: StoredUser, viewer: Viewer): Built {
  const nameBuilt = name(user, viewer);
  const bio = biography(user, viewer);
  const others = otherNames.container(user, viewer);
  const lastMs = maxMs([
    nameBuilt?.lastMs,
    bio.state === "visible" ? bio.built.lastMs : null,
    others.lastMs,
  ]);
  return {
    json: {
      "last-modified-date": stampOrNull(lastMs),
      name: nameBuilt?.json ?? null,
      "other-names": others.json,
      biography: bio.state === "visible" ? bio.built.json : null,
      path: `/${user.orcid}/personal-details`,
    },
    lastMs,
  };
}

/**
 * `/person`: ten keys in this order. Its `last-modified-date` is the latest of the six
 * containers' dates only, not the name's or the biography's (observed); `emails` and `addresses`
 * are the plural keys for the containers `/email` and `/address` serve under their singular ones.
 */
export function person(user: StoredUser, viewer: Viewer): Built {
  const nameBuilt = name(user, viewer);
  const bio = biography(user, viewer);
  const others = otherNames.container(user, viewer);
  const urls = researcherUrls.container(user, viewer);
  const mail = emails(user, viewer);
  const places = addresses.container(user, viewer);
  const words = keywords.container(user, viewer);
  const ids = externalIdentifiers.container(user, viewer);
  const lastMs = maxMs([
    places.lastMs,
    mail.lastMs,
    ids.lastMs,
    words.lastMs,
    others.lastMs,
    urls.lastMs,
  ]);
  return {
    json: {
      "last-modified-date": stampOrNull(lastMs),
      name: nameBuilt?.json ?? null,
      "other-names": others.json,
      biography: bio.state === "visible" ? bio.built.json : null,
      "researcher-urls": urls.json,
      emails: mail.json,
      addresses: places.json,
      keywords: words.json,
      "external-identifiers": ids.json,
      path: `/${user.orcid}/person`,
    },
    lastMs,
  };
}
