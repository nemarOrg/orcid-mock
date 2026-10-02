// Structural checks for the record API's JSON: which keys, in which order, with which kind of
// value. Never a count and never a value, so the same shapes hold for a fixture and for a real
// record. The key lists come from live reads of pub.orcid.org/v3.0 (Josiah Carberry's record,
// 0000-0002-1825-0097) and of pub.sandbox.orcid.org on 2026-10-01; where ORCID's data varies from
// record to record (a source, a date, a URL) the value may also be null.

export type Shape =
  | "string"
  | "number"
  | "boolean"
  | "null"
  /** Anything at all (an item of a section this suite does not read item by item). */
  | "any"
  /** Exactly this string (a path, for example). */
  | { is: string }
  /** A string that matches. */
  | { matches: RegExp }
  /** Any one of these. */
  | { either: readonly Shape[] }
  /** An array whose every element has this shape (possibly none). */
  | { list: Shape }
  /** An object with exactly these keys, in this order. */
  | { keys: { readonly [key: string]: Shape } };

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Every way `value` departs from `shape`, each prefixed with where it happened; empty if none. */
export function check(value: unknown, shape: Shape, at = "$"): string[] {
  if (shape === "any") return [];
  if (typeof shape === "string") {
    const kind = kindOf(value);
    const ok = kind === shape && (shape !== "number" || Number.isFinite(value));
    return ok ? [] : [`${at}: expected ${shape}, got ${kind}`];
  }
  if ("is" in shape) {
    return value === shape.is ? [] : [`${at}: expected ${JSON.stringify(shape.is)}`];
  }
  if ("matches" in shape) {
    return typeof value === "string" && shape.matches.test(value)
      ? []
      : [`${at}: expected a string matching ${shape.matches}, got ${kindOf(value)}`];
  }
  if ("either" in shape) {
    const attempts = shape.either.map((option) => check(value, option, at));
    if (attempts.some((problems) => problems.length === 0)) return [];
    // Report the alternative that is not null: "or null" is the boring half of an optional.
    const informative = Math.max(
      0,
      shape.either.findIndex((option) => option !== "null"),
    );
    return attempts[informative] ?? [`${at}: matches none of the allowed shapes`];
  }
  if ("list" in shape) {
    if (!Array.isArray(value)) return [`${at}: expected array, got ${kindOf(value)}`];
    return value.flatMap((element, index) => check(element, shape.list, `${at}[${index}]`));
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`${at}: expected object, got ${kindOf(value)}`];
  }
  const actual = Object.keys(value);
  const expected = Object.keys(shape.keys);
  if (actual.join("\u0000") !== expected.join("\u0000")) {
    return [`${at}: keys [${actual.join(", ")}] but expected [${expected.join(", ")}]`];
  }
  return expected.flatMap((key) =>
    check((value as Record<string, unknown>)[key], shape.keys[key] as Shape, `${at}.${key}`),
  );
}

const nullable = (shape: Shape): Shape => ({ either: ["null", shape] });
const list = (shape: Shape): Shape => ({ list: shape });
const keys = (shape: { readonly [key: string]: Shape }): Shape => ({ keys: shape });

/** `{"value": "text"}`, ORCID's wrapper for a string. */
const text = keys({ value: "string" });
/** `{"value": 1790949104286}`, ORCID's wrapper for a timestamp in epoch milliseconds. */
const stamp = keys({ value: "number" });
const identifier = keys({ uri: "string", path: "string", host: "string" });
const source = keys({
  "source-orcid": nullable(identifier),
  "source-client-id": nullable(identifier),
  "source-name": nullable(text),
  "assertion-origin-orcid": nullable(identifier),
  "assertion-origin-client-id": nullable(identifier),
  "assertion-origin-name": nullable(text),
});
/** A partial date keeps its keys and nulls the parts it lacks. */
const fuzzyDate = nullable(keys({ year: text, month: nullable(text), day: nullable(text) }));
const externalId = keys({
  "external-id-type": "string",
  "external-id-value": "string",
  "external-id-normalized": nullable(keys({ value: "string", transient: "boolean" })),
  "external-id-normalized-error": "any",
  "external-id-url": nullable(text),
  "external-id-relationship": nullable("string"),
});
const externalIds = keys({ "external-id": list(externalId) });

/** The shapes of every response the suite reads, for one iD (the `path` values name it). */
export function recordShapes(iD: string) {
  const at = (path: string): Shape => ({ is: `/${iD}${path}` });
  const itemPath = (kind: string): Shape => ({ matches: new RegExp(`^/${iD}/${kind}/\\d+$`) });

  /** A section: `last-modified-date`, its items, and its own `path`. */
  const container = (section: string, members: string, item: Shape): Shape =>
    keys({ "last-modified-date": nullable(stamp), [members]: list(item), path: at(`/${section}`) });

  /** A person-level item: its own members between the common head and the common tail. */
  const personItem = (kind: string, own: { readonly [key: string]: Shape }): Shape =>
    keys({
      "created-date": stamp,
      "last-modified-date": stamp,
      source: nullable(source),
      ...own,
      visibility: "string",
      path: itemPath(kind),
      "put-code": "number",
      "display-index": "number",
    });

  const name = keys({
    "created-date": stamp,
    "last-modified-date": stamp,
    "given-names": text,
    "family-name": nullable(text),
    "credit-name": nullable(text),
    source: nullable(source),
    visibility: "string",
    path: { is: iD },
  });
  const biography = nullable(
    keys({
      "created-date": stamp,
      "last-modified-date": stamp,
      content: "string",
      visibility: "string",
      path: at("/biography"),
    }),
  );
  const otherNames = container(
    "other-names",
    "other-name",
    personItem("other-names", { content: "string" }),
  );
  const researcherUrls = container(
    "researcher-urls",
    "researcher-url",
    personItem("researcher-urls", { "url-name": nullable("string"), url: text }),
  );
  const keywords = container("keywords", "keyword", personItem("keywords", { content: "string" }));
  const externalIdentifiers = container(
    "external-identifiers",
    "external-identifier",
    personItem("external-identifiers", {
      "external-id-type": "string",
      "external-id-value": "string",
      "external-id-url": nullable(text),
      "external-id-relationship": "string",
    }),
  );
  const addresses = container("address", "address", personItem("address", { country: text }));
  // Email items are the one kind with no put-code and no path of their own: both are null.
  const email = container(
    "email",
    "email",
    keys({
      "created-date": stamp,
      "last-modified-date": stamp,
      source: nullable(source),
      email: "string",
      path: "null",
      visibility: "string",
      verified: "boolean",
      primary: "boolean",
      "put-code": "null",
    }),
  );
  const person = keys({
    "last-modified-date": nullable(stamp),
    name: nullable(name),
    "other-names": otherNames,
    biography,
    "researcher-urls": researcherUrls,
    emails: email,
    addresses,
    keywords,
    "external-identifiers": externalIdentifiers,
    path: at("/person"),
  });

  const employmentSummary = keys({
    "created-date": stamp,
    "last-modified-date": stamp,
    source: nullable(source),
    "put-code": "number",
    "department-name": nullable("string"),
    "role-title": nullable("string"),
    "start-date": fuzzyDate,
    "end-date": fuzzyDate,
    organization: keys({
      name: "string",
      address: keys({ city: nullable("string"), region: nullable("string"), country: "string" }),
      "disambiguated-organization": nullable(
        keys({
          "disambiguated-organization-identifier": "string",
          "disambiguation-source": "string",
        }),
      ),
    }),
    url: nullable(text),
    "external-ids": nullable(externalIds),
    "display-index": "string",
    visibility: "string",
    path: itemPath("employment"),
  });
  const employments = container(
    "employments",
    "affiliation-group",
    keys({
      "last-modified-date": nullable(stamp),
      "external-ids": externalIds,
      summaries: list(keys({ "employment-summary": employmentSummary })),
    }),
  );

  const workSummary = keys({
    "put-code": "number",
    "created-date": stamp,
    "last-modified-date": stamp,
    source: nullable(source),
    title: keys({
      title: text,
      subtitle: nullable(text),
      "translated-title": nullable(keys({ value: "string", "language-code": "string" })),
    }),
    "external-ids": externalIds,
    url: nullable(text),
    type: "string",
    "publication-date": fuzzyDate,
    "journal-title": nullable(text),
    visibility: "string",
    path: itemPath("work"),
    "display-index": "string",
  });
  const works = container(
    "works",
    "group",
    keys({
      "last-modified-date": nullable(stamp),
      "external-ids": externalIds,
      "work-summary": list(workSummary),
    }),
  );

  // The other activity sections are held to their container: keys, order, and path.
  const section = (name: string, members: string): Shape => container(name, members, "any");
  const activitiesSummary = keys({
    "last-modified-date": nullable(stamp),
    distinctions: section("distinctions", "affiliation-group"),
    educations: section("educations", "affiliation-group"),
    employments,
    fundings: section("fundings", "group"),
    "invited-positions": section("invited-positions", "affiliation-group"),
    memberships: section("memberships", "affiliation-group"),
    "peer-reviews": section("peer-reviews", "group"),
    qualifications: section("qualifications", "affiliation-group"),
    "research-resources": section("research-resources", "group"),
    services: section("services", "affiliation-group"),
    works,
    path: at("/activities"),
  });

  return {
    personalDetails: keys({
      "last-modified-date": nullable(stamp),
      name,
      "other-names": otherNames,
      biography,
      path: at("/personal-details"),
    }),
    person,
    email,
    works,
    employments,
    record: keys({
      "orcid-identifier": identifier,
      preferences: keys({ locale: "string" }),
      history: keys({
        "creation-method": "string",
        "completion-date": nullable(stamp),
        "submission-date": nullable(stamp),
        "last-modified-date": nullable(stamp),
        claimed: "boolean",
        source: nullable(source),
        "deactivation-date": nullable(stamp),
        "verified-email": "boolean",
        "verified-primary-email": "boolean",
      }),
      person,
      "activities-summary": activitiesSummary,
      path: { is: `/${iD}` },
    }),
  };
}

/** The body of ORCID's v3.0 API error (404, 406, 400, 409): five keys in this order. */
export const apiError: Shape = keys({
  "response-code": "number",
  "developer-message": "string",
  "user-message": "string",
  "error-code": "number",
  "more-info": "string",
});

/** The token endpoint's `invalid_client` answer, which writes the description first. */
export const invalidClient: Shape = keys({
  error_description: "string",
  error: { is: "invalid_client" },
});

/** The record API's bad-bearer answer. */
export const invalidToken: Shape = keys({
  error: { is: "invalid_token" },
  error_description: "string",
});

/** A successful client-credentials grant: ORCID's keys in ORCID's order, with `orcid` null. */
export const clientCredentialsGrant: Shape = keys({
  access_token: "string",
  token_type: { is: "bearer" },
  refresh_token: "string",
  expires_in: "number",
  scope: { is: "/read-public" },
  orcid: "null",
});

/** What a read held, so a run can say how much it actually checked. */
export interface ItemCount {
  /** For example `3 groups, 4 summaries`. */
  text: string;
  /** The number of items, summaries counted and not their groups. */
  total: number;
}

const elements = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const member = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
/** The elements of `key` in every one of `items`, counted together. */
const countIn = (items: unknown[], key: string): number =>
  items.reduce<number>((total, item) => total + elements(member(item, key)).length, 0);

const PERSON_CONTAINERS: ReadonlyArray<readonly [label: string, container: string, items: string]> =
  [
    ["other names", "other-names", "other-name"],
    ["researcher URLs", "researcher-urls", "researcher-url"],
    ["emails", "emails", "email"],
    ["addresses", "addresses", "address"],
    ["keywords", "keywords", "keyword"],
    ["external identifiers", "external-identifiers", "external-identifier"],
  ];

function personCount(person: unknown): ItemCount {
  const parts = PERSON_CONTAINERS.map(([label, container, items]) => ({
    label,
    count: elements(member(member(person, container), items)).length,
  }));
  return {
    text: parts.map(({ label, count }) => `${count} ${label}`).join(", "),
    total: parts.reduce((total, { count }) => total + count, 0),
  };
}

function activityCount(
  container: unknown,
  groups: "group" | "affiliation-group",
  summaries: string,
): ItemCount {
  const grouped = elements(member(container, groups));
  const total = countIn(grouped, summaries);
  return { text: `${grouped.length} groups, ${total} summaries`, total };
}

/**
 * How many items a read of `section` held (`json` has already passed `check`): works and
 * employments by group and summary, email by item, a person's containers by kind.
 */
export function countItems(section: string, json: unknown): ItemCount {
  switch (section) {
    case "works":
      return activityCount(json, "group", "work-summary");
    case "employments":
      return activityCount(json, "affiliation-group", "summaries");
    case "email": {
      const total = elements(member(json, "email")).length;
      return { text: `${total} emails`, total };
    }
    case "personal-details": {
      const total = elements(member(member(json, "other-names"), "other-name")).length;
      return { text: `${total} other names`, total };
    }
    case "person":
      return personCount(json);
    case "record": {
      const activities = member(json, "activities-summary");
      const person = personCount(member(json, "person"));
      const works = activityCount(member(activities, "works"), "group", "work-summary");
      const employments = activityCount(
        member(activities, "employments"),
        "affiliation-group",
        "summaries",
      );
      return {
        text: `person: ${person.text}; works: ${works.text}; employments: ${employments.text}`,
        total: person.total + works.total + employments.total,
      };
    }
    default:
      return { text: "no items counted", total: 0 };
  }
}
