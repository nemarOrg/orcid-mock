// The users-file schema: Zod is the source, the JSON Schema in fixtures/users.schema.json is
// generated from it, and a test fails when that file is stale.
// Snake_case field names transliterate ORCID's own (department_name, role_title, ...), so the
// record-API projection in phase 4 is mechanical. Strict objects, no transforms.
import { z } from "zod";
import { isValidOrcidId } from "../orcid-id";

// Workers forbid `new Function`, which Zod would otherwise use to compile parsers.
z.config({ jitless: true });

export type PathSegment = string | number;

/** A rule failure with its location as path segments, before it is formatted for a person. */
export interface RawIssue {
  path: PathSegment[];
  message: string;
}

export interface Issue {
  /** Dotted and bracketed, such as `users[1].emails[0].visibility`; empty for the root. */
  path: string;
  message: string;
}

/** Formats a Zod issue path as `users[1].emails[0].visibility`. */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

const ORCID_SHAPE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

// Years 1900 to 2100 are the bounds of ORCID's v3.0 XSD: ORCID/orcid-model
// src/main/resources/common_3.0/common-3.0.xsd, the fuzzy-date types.
const FUZZY_DATE = /^(?:19\d{2}|20\d{2}|2100)(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/;

function isRealDate(date: string): boolean {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return true;
  // Day zero of the next month is the last day of this one.
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// A shape used in more than one place carries an `id`, so the generated JSON Schema defines it
// once under `$defs` and points at it, instead of inlining a copy at every use.
export const FuzzyDate = z
  .string()
  .regex(FUZZY_DATE, "Expected YYYY, YYYY-MM, or YYYY-MM-DD with a year from 1900 to 2100")
  .refine(isRealDate, "Not a real calendar date")
  .meta({ id: "FuzzyDate" });

export const Visibility = z.enum(["public", "limited", "private"]).meta({ id: "Visibility" });
export type Visibility = z.output<typeof Visibility>;

const PutCode = z
  .int()
  .positive()
  .meta({
    id: "PutCode",
    description: "Assigned at load from a counter when omitted; unique within its section",
  })
  .optional();
const DisplayIndex = z.int().nonnegative().meta({ id: "DisplayIndex" }).optional();
const OptionalString = z.string().nullish();
const OptionalUrl = z.url().nullish();
const CountryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, "Expected an ISO 3166-1 alpha-2 country code")
  .meta({ id: "CountryCode" });

/** An item that carries a put-code, a visibility, and a display index in ORCID. */
function item<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject({
    put_code: PutCode,
    ...shape,
    visibility: Visibility,
    display_index: DisplayIndex,
  });
}

// The fields of an external identifier, shared by the identifiers on a record (which are items)
// and by the ids on a work, funding, affiliation, or review (which are not).
const externalIdFields = {
  external_id_type: z.string().min(1),
  external_id_value: z.string().min(1),
  external_id_url: OptionalUrl,
  external_id_relationship: z.enum(["self", "part-of", "version-of", "funded-by"]).nullish(),
};

export const ExternalId = z.strictObject(externalIdFields).meta({ id: "ExternalId" });

export const Organization = z
  .strictObject({
    name: z.string().min(1),
    address: z.strictObject({
      city: z.string().min(1),
      region: OptionalString,
      country: CountryCode,
    }),
    disambiguated_organization: z
      .strictObject({
        disambiguated_organization_identifier: z.string().min(1),
        disambiguation_source: z.string().min(1),
      })
      .nullish(),
  })
  .meta({ id: "Organization" });

const TranslatedTitle = z
  .strictObject({ value: z.string().min(1), language_code: z.string().min(1) })
  .meta({ id: "TranslatedTitle" })
  .nullish();

export const Name = z.strictObject({
  given_names: z.string().min(1),
  family_name: OptionalString,
  credit_name: OptionalString,
  visibility: Visibility,
});

export const Biography = z.strictObject({ content: z.string().min(1), visibility: Visibility });

// ORCID's email items have no put-code (the wire value is null).
export const Email = z.strictObject({
  email: z.email(),
  primary: z.boolean(),
  verified: z.boolean(),
  visibility: Visibility,
});

export const OtherName = item({ content: z.string().min(1) });
export const Address = item({ country: CountryCode });
export const Keyword = item({ content: z.string().min(1) });
export const ExternalIdentifier = item(externalIdFields);
export const ResearcherUrl = item({ url_name: OptionalString, url: z.url() });

const affiliationShape = {
  department_name: OptionalString,
  role_title: OptionalString,
  start_date: FuzzyDate.nullish(),
  end_date: FuzzyDate.nullish(),
  organization: Organization,
  url: OptionalUrl,
  external_ids: z.array(ExternalId).optional(),
};
// Employments, educations, and qualifications share one shape in ORCID's model.
export const Affiliation = item(affiliationShape).meta({ id: "Affiliation" });
export const Employment = Affiliation;
export const Education = Affiliation;
export const Qualification = Affiliation;

export const Contributor = z.strictObject({
  contributor_orcid: z
    .string()
    .regex(ORCID_SHAPE, "Expected an ORCID iD such as 0000-0002-1825-0097")
    .nullish(),
  credit_name: z.string().min(1),
  contributor_sequence: z.enum(["first", "additional"]).nullish(),
  contributor_role: OptionalString,
});

export const Work = item({
  title: z.string().min(1),
  subtitle: OptionalString,
  translated_title: TranslatedTitle,
  journal_title: OptionalString,
  short_description: OptionalString,
  citation: z
    .strictObject({ citation_type: z.string().min(1), citation_value: z.string().min(1) })
    .nullish(),
  type: z.string().regex(/^[a-z]+(-[a-z]+)*$/, "Expected a lowercase-hyphen ORCID work type"),
  publication_date: FuzzyDate.nullish(),
  external_ids: z.array(ExternalId).optional(),
  url: OptionalUrl,
  contributors: z.array(Contributor).optional(),
  language_code: OptionalString,
  country: CountryCode.nullish(),
});

export const Funding = item({
  title: z.string().min(1),
  translated_title: TranslatedTitle,
  type: z.enum(["grant", "contract", "award", "salary-award"]),
  start_date: FuzzyDate.nullish(),
  end_date: FuzzyDate.nullish(),
  organization: Organization,
  external_ids: z.array(ExternalId).optional(),
  url: OptionalUrl,
});

export const PeerReview = item({
  reviewer_role: z.enum(["reviewer", "editor", "member", "chair", "organizer"]),
  review_type: z.enum(["review", "evaluation"]),
  review_url: OptionalUrl,
  review_group_id: z.string().min(1),
  completion_date: FuzzyDate.nullish(),
  convening_organization: Organization,
  external_ids: z.array(ExternalId).optional(),
});

/** The sections whose items carry a put-code; put-codes are unique within a section. */
export const PUT_CODE_SECTIONS = [
  "other_names",
  "addresses",
  "keywords",
  "external_identifiers",
  "researcher_urls",
  "employments",
  "educations",
  "qualifications",
  "works",
  "fundings",
  "peer_reviews",
] as const;
export type PutCodeSection = (typeof PUT_CODE_SECTIONS)[number];

/**
 * A checksum failure on an iD that already has the right shape; a wrong shape is reported by the
 * field's own pattern check.
 */
function checksumIssue(value: string | null | undefined, path: PathSegment[]): RawIssue[] {
  if (value == null || !ORCID_SHAPE.test(value) || isValidOrcidId(value)) return [];
  return [
    { path, message: "Invalid ORCID iD: the check character does not match ISO 7064 MOD 11-2" },
  ];
}

const OrcidField = z
  .string()
  .regex(/^(?:\d{4}-\d{4}-\d{4}-\d{3}[\dX])?$/, "Expected an ORCID iD such as 0000-0002-1825-0097");

const UserShape = z.strictObject({
  orcid: OrcidField.optional().describe(
    "Any block is accepted if the checksum is right; empty or absent mints an iD from the mint block",
  ),
  claimed: z.boolean().optional().describe("Absent means claimed"),
  locked: z.boolean().optional(),
  deactivated: z.boolean().optional(),
  deprecated_to: OrcidField.optional().describe("The primary record this one was merged into"),
  name: Name,
  other_names: z.array(OtherName).optional(),
  biography: Biography.nullish(),
  emails: z.array(Email).optional(),
  addresses: z.array(Address).optional(),
  keywords: z.array(Keyword).optional(),
  external_identifiers: z.array(ExternalIdentifier).optional(),
  researcher_urls: z.array(ResearcherUrl).optional(),
  employments: z.array(Employment).optional(),
  educations: z.array(Education).optional(),
  qualifications: z.array(Qualification).optional(),
  works: z.array(Work).optional(),
  fundings: z.array(Funding).optional(),
  peer_reviews: z.array(PeerReview).optional(),
});

/** Rules that need one user only. */
function userIssues(user: z.output<typeof UserShape>): RawIssue[] {
  const issues: RawIssue[] = [];
  issues.push(...checksumIssue(user.orcid, ["orcid"]));
  issues.push(...checksumIssue(user.deprecated_to, ["deprecated_to"]));
  if (user.deprecated_to !== undefined && user.deprecated_to === user.orcid) {
    issues.push({ path: ["deprecated_to"], message: "A record cannot be deprecated to itself" });
  }

  const emails = user.emails ?? [];
  const seen = new Set<string>();
  emails.forEach((email, k) => {
    // ORCID's rule: "Only verified email addresses can be displayed publicly or shared with
    // trusted parties", that is, public or limited (`manage.email.only_verified` in
    // ORCID/ORCID-Source orcid-core/src/main/resources/i18n/messages_en.properties).
    if (email.visibility !== "private" && !email.verified) {
      issues.push({
        path: ["emails", k, "visibility"],
        message: "Only a verified email can be public or limited",
      });
    }
    const key = email.email.toLowerCase();
    if (seen.has(key)) {
      issues.push({
        path: ["emails", k, "email"],
        message: `Duplicate email ${email.email} within this user`,
      });
    }
    seen.add(key);
  });
  if (emails.length > 0) {
    const primaries = emails.filter((email) => email.primary).length;
    if (primaries !== 1) {
      issues.push({
        path: ["emails"],
        message: `Exactly one email must be primary, found ${primaries}`,
      });
    }
  }

  (user.works ?? []).forEach((work, w) => {
    (work.contributors ?? []).forEach((contributor, c) => {
      issues.push(
        ...checksumIssue(contributor.contributor_orcid, [
          "works",
          w,
          "contributors",
          c,
          "contributor_orcid",
        ]),
      );
    });
  });
  return issues;
}

export const FixtureUser = UserShape.superRefine((user, ctx) => {
  for (const issue of userIssues(user)) {
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
});

export const FixtureClient = z.strictObject({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  name: z.string().optional().describe("Shown on the consent page; defaults to the client_id"),
  redirect_uris: z.array(z.url()).min(1),
  member: z.boolean().optional().describe("A member client may read limited items; default false"),
});

/** The part of a user the cross-user checks read; a stored user satisfies it structurally. */
export type CrossCheckUser = {
  orcid?: string | undefined;
  emails?: ReadonlyArray<{ email: string }> | undefined;
} & {
  [S in PutCodeSection]?: ReadonlyArray<{ put_code?: number | undefined }> | undefined;
};

/**
 * Rules that compare users: duplicate iD, duplicate email (case-insensitive), and a put-code
 * repeated within one section.
 * Each issue's path starts `users`, then the index; the single-user admin check reuses this on the store's
 * users plus the new one and keeps the issues for the new one.
 */
export function crossUserIssues(users: ReadonlyArray<CrossCheckUser>): RawIssue[] {
  const issues: RawIssue[] = [];
  const orcids = new Map<string, number>();
  const emails = new Map<string, number>();
  const putCodes = new Map<string, number>();
  users.forEach((user, i) => {
    if (user.orcid !== undefined && user.orcid !== "") {
      const first = orcids.get(user.orcid);
      if (first !== undefined && first !== i) {
        issues.push({
          path: ["users", i, "orcid"],
          message: `Duplicate ORCID iD ${user.orcid} (first used by users[${first}])`,
        });
      } else {
        orcids.set(user.orcid, i);
      }
    }
    (user.emails ?? []).forEach((email, k) => {
      const key = email.email.toLowerCase();
      const first = emails.get(key);
      if (first !== undefined && first !== i) {
        issues.push({
          path: ["users", i, "emails", k, "email"],
          message: `Duplicate email ${email.email} (first used by users[${first}], case-insensitive)`,
        });
      } else if (first === undefined) {
        emails.set(key, i);
      }
    });
    for (const section of PUT_CODE_SECTIONS) {
      (user[section] ?? []).forEach((entry, k) => {
        if (entry.put_code === undefined) return;
        const key = `${section}:${entry.put_code}`;
        const first = putCodes.get(key);
        if (first !== undefined) {
          issues.push({
            path: ["users", i, section, k, "put_code"],
            message: `Duplicate put_code ${entry.put_code} in ${section} (first used by users[${first}])`,
          });
        } else {
          putCodes.set(key, i);
        }
      });
    }
  });
  return issues;
}

/**
 * Deprecation rules, which need the resolved iDs (minted ones included): a record cannot be
 * deprecated to itself, and following `deprecated_to` from a record must not lead back to it.
 * Each issue's path is `users`, the index, `deprecated_to`.
 */
export function deprecationIssues(
  users: ReadonlyArray<{ orcid: string; deprecated_to?: string | undefined }>,
): RawIssue[] {
  const target = new Map<string, string>();
  for (const user of users) {
    if (user.deprecated_to !== undefined) target.set(user.orcid, user.deprecated_to);
  }
  const issues: RawIssue[] = [];
  users.forEach((user, i) => {
    if (user.deprecated_to === undefined) return;
    const path = ["users", i, "deprecated_to"];
    if (user.deprecated_to === user.orcid) {
      issues.push({ path, message: "A record cannot be deprecated to itself" });
      return;
    }
    const chain = [user.orcid];
    let next: string | undefined = user.deprecated_to;
    while (next !== undefined) {
      chain.push(next);
      if (next === user.orcid) {
        issues.push({ path, message: `Deprecation cycle: ${chain.join(" -> ")}` });
        return;
      }
      // A cycle that does not include this record is reported on its own members.
      if (chain.indexOf(next) !== chain.length - 1) return;
      next = target.get(next);
    }
  });
  return issues;
}

export const UsersFile = z
  .strictObject({
    $schema: z.string().optional(),
    clients: z.array(FixtureClient),
    users: z.array(FixtureUser),
  })
  .superRefine((file, ctx) => {
    const clients = new Map<string, number>();
    file.clients.forEach((client, i) => {
      const first = clients.get(client.client_id);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["clients", i, "client_id"],
          message: `Duplicate client_id ${client.client_id} (first used by clients[${first}])`,
        });
      } else {
        clients.set(client.client_id, i);
      }
    });
    for (const issue of crossUserIssues(file.users)) {
      ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
  });

export type FixtureExternalId = z.output<typeof ExternalId>;
export type FixtureOrganization = z.output<typeof Organization>;
export type FixtureName = z.output<typeof Name>;
export type FixtureBiography = z.output<typeof Biography>;
export type FixtureEmail = z.output<typeof Email>;
export type FixtureOtherName = z.output<typeof OtherName>;
export type FixtureAddress = z.output<typeof Address>;
export type FixtureKeyword = z.output<typeof Keyword>;
export type FixtureExternalIdentifier = z.output<typeof ExternalIdentifier>;
export type FixtureResearcherUrl = z.output<typeof ResearcherUrl>;
export type FixtureEmployment = z.output<typeof Employment>;
export type FixtureEducation = z.output<typeof Education>;
export type FixtureQualification = z.output<typeof Qualification>;
export type FixtureWork = z.output<typeof Work>;
export type FixtureFunding = z.output<typeof Funding>;
export type FixturePeerReview = z.output<typeof PeerReview>;
export type FixtureUser = z.output<typeof FixtureUser>;
export type FixtureClient = z.output<typeof FixtureClient>;
/** The shape of a users file as a person writes it. */
export type UsersFileInput = z.input<typeof UsersFile>;
export type UsersFileData = z.output<typeof UsersFile>;

/** Where the generated schema is published; also its `$id` and what `orcid-mock fixture` names. */
export const USERS_SCHEMA_ID =
  "https://raw.githubusercontent.com/nemarOrg/orcid-mock/main/fixtures/users.schema.json";

/** The JSON Schema for the users file, generated from the Zod source with `io: "input"`. */
export function usersFileJsonSchema(): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(UsersFile, { io: "input" });
  return {
    $schema,
    $id: USERS_SCHEMA_ID,
    title: "orcid-mock users file",
    description:
      "Clients and users for orcid-mock, an ephemeral mock of the Open Researcher and Contributor ID (ORCID) service. " +
      "Field names transliterate ORCID's own. " +
      "Rules a JSON Schema cannot express (checksums, duplicates, one primary email) are enforced when the file loads.",
    ...rest,
  };
}

/** The generated schema as the text committed to fixtures/users.schema.json. */
export function usersFileJsonSchemaText(): string {
  return `${JSON.stringify(usersFileJsonSchema(), null, 2)}\n`;
}
