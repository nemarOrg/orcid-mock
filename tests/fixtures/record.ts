// The record API's test fixture: fictional people only. Josiah Carberry is ORCID's own fictional
// demo record, modeled here on its public shapes with invented values; every other name, email,
// title, and identifier is made up, and every iD is minted in the `0009-9` block, which cannot
// collide with a real person by construction (ADR 0003).
// Put-codes are explicit so the tests can name them: 1xxx and 2xxx are Marisol Quenby's, 3xxx
// the grouping user's, 4xxx the all-private user's, 5xxx Carberry's, and 6xxx the private-name user's.
import type { UsersFileInput } from "../../src/fixtures/schema";
import { STARTER_USERS_FILE } from "../../src/fixtures/starter";

export const IDS = {
  carberry: "0000-0002-1825-0097",
  /** Every section populated with public, limited, and private items. */
  rich: "0009-9310-3508-7525",
  /** A public name with no family name and no credit name, and no biography at all. */
  nullFamily: "0009-9677-7899-2440",
  /** A private name, and a public biography. */
  privateName: "0009-9145-0852-2685",
  /** Merged into `primary`. */
  deprecated: "0009-9087-7261-8095",
  primary: "0009-9292-3185-1217",
  locked: "0009-9824-5075-1905",
  deactivated: "0009-9166-5697-6020",
  unclaimed: "0009-9894-1696-1847",
  /** Locked and deactivated: locked is reported. */
  lockedDeactivated: "0009-9518-7436-0500",
  /** Deprecated and locked: deprecated is reported. */
  deprecatedLocked: "0009-9953-9216-6347",
  /** Unclaimed and locked: unclaimed is reported. */
  unclaimedLocked: "0009-9028-2964-0473",
  /** Works, affiliations, fundings, and peer reviews that exercise grouping and ordering. */
  grouping: "0009-9673-3459-6965",
  /** A biography that is not public, and a public name. */
  bioPrivate: "0009-9402-4754-4155",
  /** Nothing public except the name. */
  allPrivate: "0009-9903-5930-8005",
} as const;

type FixtureUser = UsersFileInput["users"][number];

const HARTWELL = {
  name: "Hartwell Institute of Applied Psychoceramics",
  address: { city: "Hartwell", region: "CT", country: "US" },
  disambiguated_organization: {
    disambiguated_organization_identifier: "https://ror.org/00hartwell00",
    disambiguation_source: "ROR",
  },
} as const;

const BROWNLOW = {
  name: "Brownlow College",
  address: { city: "Brownlow", country: "GB" },
} as const;

const FUNDER = {
  name: "Example Science Foundation",
  address: { city: "Auckland", country: "NZ" },
  disambiguated_organization: {
    disambiguated_organization_identifier: "https://ror.org/00funder000",
    disambiguation_source: "ROR",
  },
} as const;

const JOURNAL_BODY = {
  name: "Society of Imaginary Journals",
  address: { city: "London", region: "England", country: "GB" },
} as const;

const doi = (value: string, relationship: "self" | "part-of" | "version-of" = "self") => ({
  external_id_type: "doi",
  external_id_value: value,
  external_id_relationship: relationship,
});

const carberry: FixtureUser = {
  orcid: IDS.carberry,
  name: { given_names: "Josiah", family_name: "Carberry", credit_name: null, visibility: "public" },
  other_names: [
    { put_code: 5001, content: "Josiah Stinkney Carberry", visibility: "public", display_index: 3 },
    { put_code: 5002, content: "J. S. Carberry", visibility: "public", display_index: 2 },
    { put_code: 5003, content: "J. Carberry", visibility: "public", display_index: 1 },
  ],
  biography: {
    content: "A fictional professor of psychoceramics.\r\n\r\nUsed to demonstrate ORCID.",
    visibility: "public",
  },
  // The only email is private, so the public container is empty while the record's history
  // still says a verified email exists.
  emails: [
    { email: "josiah.carberry@example.test", primary: true, verified: true, visibility: "private" },
  ],
  keywords: [{ put_code: 5101, content: "psychoceramics", visibility: "public", display_index: 3 }],
  researcher_urls: [
    {
      put_code: 5201,
      url_name: "Hartwell Institute page",
      url: "https://example.test/carberry",
      visibility: "public",
      display_index: 2,
    },
  ],
  external_identifiers: [
    {
      put_code: 5301,
      external_id_type: "Scopus Author ID",
      external_id_value: "7000000001",
      external_id_url: "https://example.test/scopus/7000000001",
      external_id_relationship: "self",
      visibility: "public",
      display_index: 0,
    },
  ],
  employments: [
    {
      put_code: 5401,
      department_name: "Psychoceramics",
      role_title: "Professor",
      start_date: "1930-03-01",
      end_date: null,
      organization: HARTWELL,
      visibility: "public",
    },
    {
      put_code: 5402,
      department_name: "Cracked Pots",
      role_title: "Lecturer",
      start_date: "1929-02",
      end_date: "1930-02-28",
      organization: BROWNLOW,
      visibility: "public",
    },
  ],
  works: [
    {
      put_code: 5501,
      title: "On the Fracture Mechanics of Glazed Vessels",
      subtitle: "A pilot study",
      journal_title: "Journal of Imaginary Ceramics",
      type: "journal-article",
      publication_date: "2012",
      external_ids: [
        {
          external_id_type: "issn",
          external_id_value: "0000-0001",
          external_id_relationship: "part-of",
        },
        doi("10.5555/carberry.0001"),
      ],
      visibility: "public",
      display_index: 2,
    },
    {
      put_code: 5502,
      title: "On the Fracture Mechanics of Glazed Vessels",
      type: "journal-article",
      publication_date: "2012",
      external_ids: [doi("10.5555/carberry.0001")],
      visibility: "public",
      display_index: 1,
    },
    {
      put_code: 5503,
      title: "Plasmons in Layered Earthenware",
      journal_title: "Proceedings of Imaginary Physics",
      type: "journal-article",
      publication_date: "1987",
      external_ids: [
        doi("10.5555/carberry.0002"),
        {
          external_id_type: "eid",
          external_id_value: "2-s2.0-0000000001",
          external_id_relationship: "self",
        },
      ],
      url: "https://example.test/works/plasmons",
      visibility: "public",
      display_index: 0,
    },
  ],
  peer_reviews: [
    {
      put_code: 5601,
      reviewer_role: "reviewer",
      review_type: "review",
      review_group_id: "issn:0000-0001",
      completion_date: "2004-02-02",
      convening_organization: JOURNAL_BODY,
      external_ids: [
        {
          external_id_type: "source-work-id",
          external_id_value: "10001",
          external_id_relationship: "self",
        },
      ],
      visibility: "public",
    },
  ],
};

/** Marisol Quenby: every section holds a public, a limited, and a private item. */
const rich: FixtureUser = {
  orcid: IDS.rich,
  name: {
    given_names: "Marisol",
    family_name: "Quenby",
    credit_name: "M. Quenby",
    visibility: "public",
  },
  other_names: [
    { put_code: 1001, content: "Mari Quenby", visibility: "public", display_index: 2 },
    { put_code: 1002, content: "M. L. Quenby", visibility: "limited", display_index: 1 },
    { put_code: 1003, content: "Hidden Alias", visibility: "private", display_index: 0 },
  ],
  biography: { content: "A fictional researcher of fictional signals.", visibility: "public" },
  emails: [
    { email: "marisol.quenby@example.test", primary: true, verified: true, visibility: "public" },
    {
      email: "marisol.limited@example.test",
      primary: false,
      verified: true,
      visibility: "limited",
    },
    {
      email: "marisol.private@example.test",
      primary: false,
      verified: true,
      visibility: "private",
    },
  ],
  addresses: [
    { put_code: 1101, country: "NZ", visibility: "public", display_index: 1 },
    { put_code: 1102, country: "AU", visibility: "limited", display_index: 0 },
    { put_code: 1103, country: "CA", visibility: "private", display_index: 0 },
  ],
  keywords: [
    { put_code: 1201, content: "signal processing", visibility: "public", display_index: 2 },
    { put_code: 1202, content: "limited keyword", visibility: "limited", display_index: 1 },
    { put_code: 1203, content: "private keyword", visibility: "private", display_index: 0 },
  ],
  external_identifiers: [
    {
      put_code: 1301,
      external_id_type: "Scopus Author ID",
      external_id_value: "7000000002",
      external_id_url: "https://example.test/scopus/7000000002",
      external_id_relationship: "self",
      visibility: "public",
      display_index: 1,
    },
    {
      put_code: 1302,
      external_id_type: "ResearcherID",
      external_id_value: "L-0002-2020",
      visibility: "limited",
      display_index: 0,
    },
    {
      put_code: 1303,
      external_id_type: "Loop profile",
      external_id_value: "private-1",
      visibility: "private",
      display_index: 0,
    },
  ],
  researcher_urls: [
    {
      put_code: 1401,
      url_name: "Lab",
      url: "https://example.test/quenby",
      visibility: "public",
      display_index: 1,
    },
    { put_code: 1402, url: "https://example.test/quenby/limited", visibility: "limited" },
    { put_code: 1403, url: "https://example.test/quenby/private", visibility: "private" },
  ],
  employments: [
    {
      put_code: 1501,
      department_name: "Signals",
      role_title: "Research Scientist",
      start_date: "2019-09",
      end_date: null,
      organization: HARTWELL,
      url: "https://example.test/hartwell",
      visibility: "public",
    },
    {
      put_code: 1502,
      role_title: "Postdoctoral Fellow",
      start_date: "2016-01-04",
      end_date: "2019-08-31",
      organization: BROWNLOW,
      visibility: "limited",
    },
    {
      put_code: 1503,
      role_title: "Intern",
      start_date: "2014",
      organization: BROWNLOW,
      visibility: "private",
    },
  ],
  educations: [
    {
      put_code: 1601,
      department_name: "Department of Signals",
      role_title: "Doctor of Philosophy",
      start_date: "2012-02",
      end_date: "2016-12-15",
      organization: BROWNLOW,
      external_ids: [
        {
          external_id_type: "grant_number",
          external_id_value: "DEG-2016-01",
          external_id_url: "https://example.test/degrees/1",
          external_id_relationship: "self",
        },
      ],
      visibility: "public",
    },
    {
      put_code: 1602,
      role_title: "Master of Science",
      start_date: "2010",
      end_date: "2011",
      organization: BROWNLOW,
      visibility: "limited",
    },
    { put_code: 1603, role_title: "Diploma", organization: BROWNLOW, visibility: "private" },
  ],
  qualifications: [
    {
      put_code: 1701,
      role_title: "Certified Data Steward",
      start_date: "2021",
      organization: HARTWELL,
      visibility: "public",
    },
    {
      put_code: 1702,
      role_title: "Limited certificate",
      organization: HARTWELL,
      visibility: "limited",
    },
    {
      put_code: 1703,
      role_title: "Private certificate",
      organization: HARTWELL,
      visibility: "private",
    },
  ],
  fundings: [
    {
      put_code: 1801,
      title: "Fictional Signals Initiative",
      translated_title: { value: "Initiative des signaux fictifs", language_code: "fr" },
      type: "grant",
      start_date: "2020-01",
      end_date: "2023-12",
      organization: FUNDER,
      external_ids: [
        {
          external_id_type: "grant_number",
          external_id_value: "EXF-2020-001",
          external_id_url: "https://example.test/grants/1",
          external_id_relationship: "self",
        },
      ],
      url: "https://example.test/initiative",
      visibility: "public",
      display_index: 1,
    },
    {
      put_code: 1802,
      title: "Limited fellowship",
      type: "award",
      organization: FUNDER,
      visibility: "limited",
    },
    {
      put_code: 1803,
      title: "Private contract",
      type: "contract",
      organization: FUNDER,
      visibility: "private",
    },
  ],
  peer_reviews: [
    {
      put_code: 1901,
      reviewer_role: "reviewer",
      review_type: "review",
      review_url: "https://example.test/reviews/1",
      review_group_id: "issn:0000-0002",
      completion_date: "2023-06-01",
      convening_organization: JOURNAL_BODY,
      external_ids: [
        {
          external_id_type: "source-work-id",
          external_id_value: "20001",
          external_id_relationship: "self",
        },
      ],
      visibility: "public",
    },
    {
      put_code: 1902,
      reviewer_role: "editor",
      review_type: "evaluation",
      review_group_id: "issn:0000-0003",
      completion_date: "2022",
      convening_organization: JOURNAL_BODY,
      visibility: "limited",
    },
    {
      put_code: 1903,
      reviewer_role: "chair",
      review_type: "review",
      review_group_id: "issn:0000-0004",
      convening_organization: JOURNAL_BODY,
      visibility: "private",
    },
  ],
  works: [
    {
      put_code: 2001,
      title: "Signals in Imaginary Noise",
      subtitle: "A reappraisal",
      translated_title: { value: "Signaux dans le bruit imaginaire", language_code: "fr" },
      journal_title: "Journal of Imaginary Neuroscience",
      short_description: "A public article.",
      citation: {
        citation_type: "bibtex",
        citation_value: "@article{quenby2022, title={Signals}}",
      },
      type: "journal-article",
      publication_date: "2022-03-14",
      external_ids: [doi("10.5555/rich.0001")],
      url: "https://doi.org/10.5555/rich.0001",
      contributors: [
        {
          credit_name: "Marisol Quenby",
          contributor_sequence: "first",
          contributor_role: "author",
        },
        {
          contributor_orcid: IDS.carberry,
          credit_name: "Josiah Carberry",
          contributor_sequence: "additional",
          contributor_role: "author",
        },
        { credit_name: "A. Collaborator" },
      ],
      language_code: "en",
      country: "NZ",
      visibility: "public",
      display_index: 0,
    },
    {
      put_code: 2002,
      title: "A limited dataset",
      type: "data-set",
      publication_date: "2020",
      external_ids: [doi("10.5555/rich.0002")],
      visibility: "limited",
    },
    {
      put_code: 2003,
      title: "A private draft",
      type: "other",
      external_ids: [doi("10.5555/rich.0003")],
      visibility: "private",
    },
  ],
};

const grantId = (value: string, relationship: "self" | "funded-by" = "self") => ({
  external_id_type: "grant_number",
  external_id_value: value,
  external_id_relationship: relationship,
});

const employment = (
  put_code: number,
  fields: {
    start_date?: string;
    end_date?: string;
    visibility?: "public" | "limited" | "private";
    display_index?: number;
    external_ids?: ReturnType<typeof grantId>[];
    role_title?: string;
  },
) => ({
  put_code,
  organization: HARTWELL,
  visibility: "public" as const,
  ...fields,
});

const work = (
  put_code: number,
  title: string,
  fields: {
    type?: string;
    publication_date?: string;
    external_ids?: Array<
      | ReturnType<typeof doi>
      | {
          external_id_type: string;
          external_id_value: string;
          external_id_relationship: "part-of" | "self";
        }
    >;
    display_index?: number;
    visibility?: "public" | "limited" | "private";
  },
) => ({
  put_code,
  title,
  type: "journal-article",
  visibility: "public" as const,
  ...fields,
});

const issn = (value: string, relationship: "part-of" | "self") => ({
  external_id_type: "issn",
  external_id_value: value,
  external_id_relationship: relationship,
});

const review = (
  put_code: number,
  review_group_id: string,
  fields: {
    completion_date?: string;
    external_ids?: Array<{
      external_id_type: string;
      external_id_value: string;
      external_id_relationship: "self";
    }>;
    visibility?: "public" | "limited" | "private";
  },
) => ({
  put_code,
  reviewer_role: "reviewer" as const,
  review_type: "review" as const,
  review_group_id,
  convening_organization: JOURNAL_BODY,
  visibility: "public" as const,
  ...fields,
});

const workId = (value: string) => ({
  external_id_type: "source-work-id",
  external_id_value: value,
  external_id_relationship: "self" as const,
});

/**
 * Grouping and ordering. Work groups, by publication date newest first, then title, then type:
 * 3201+3202 (2022-03-14), 3215 (2022-03), 3216 (2022), 3204 (2021-10), 3203 (2020),
 * 3205+3206+3207 (2019, one group by a bridge), 3208+3209 (2018, version-of ids group), 3210
 * (2017, no ids), 3213 (2016, whose hidden twin 3214 is not part of it), 3218 and 3217 (2015, by
 * type), 3220 and 3219 (2014, by title), and 3221 (no date). 3211+3212 are private and gone.
 */
const grouping: FixtureUser = {
  orcid: IDS.grouping,
  name: {
    given_names: "Corwin",
    family_name: "Delacourt",
    credit_name: null,
    visibility: "public",
  },
  employments: [
    employment(3101, { start_date: "2015", display_index: 0, external_ids: [grantId("G-1")] }),
    employment(3102, { start_date: "2017-03", display_index: 5, external_ids: [grantId("G-1")] }),
    employment(3103, {}),
    employment(3104, { start_date: "2018-06" }),
    employment(3105, { start_date: "2010", end_date: "2012-05" }),
    employment(3106, { start_date: "2011", end_date: "2014-01" }),
    employment(3107, { visibility: "private", external_ids: [grantId("G-2"), grantId("G-3")] }),
    employment(3108, { external_ids: [grantId("G-2"), grantId("F-1", "funded-by")] }),
    employment(3109, { visibility: "private", external_ids: [grantId("G-9")] }),
    employment(3110, { visibility: "private", external_ids: [grantId("G-9")] }),
  ],
  works: [
    work(3201, "Alpha Study", {
      publication_date: "2022-03-14",
      external_ids: [doi("10.5555/GROUP.A"), issn("1111-2222", "part-of")],
      display_index: 2,
    }),
    work(3202, "Alpha Study", {
      publication_date: "2022-03-14",
      external_ids: [doi("10.5555/group.a")],
      display_index: 1,
    }),
    work(3203, "Beta Study", {
      publication_date: "2020",
      external_ids: [issn("3333-4444", "part-of")],
    }),
    work(3204, "Gamma Study", {
      publication_date: "2021-10",
      external_ids: [issn("3333-4444", "part-of")],
    }),
    work(3205, "Delta one", { publication_date: "2019", external_ids: [doi("10.5555/t.x")] }),
    work(3206, "Delta two", { publication_date: "2019", external_ids: [doi("10.5555/t.y")] }),
    work(3207, "Delta bridge", {
      publication_date: "2019",
      external_ids: [doi("10.5555/t.x"), doi("10.5555/t.y")],
    }),
    work(3208, "Epsilon", {
      publication_date: "2018",
      external_ids: [doi("10.5555/v.1", "version-of")],
    }),
    work(3209, "Epsilon, second version", {
      publication_date: "2018",
      external_ids: [doi("10.5555/v.1", "version-of")],
    }),
    work(3210, "Zeta", { publication_date: "2017" }),
    work(3211, "Eta hidden", {
      external_ids: [doi("10.5555/hid")],
      visibility: "private",
    }),
    work(3212, "Eta hidden twin", {
      external_ids: [doi("10.5555/hid")],
      visibility: "limited",
    }),
    work(3213, "Theta", { publication_date: "2016", external_ids: [doi("10.5555/w.1")] }),
    work(3214, "Theta hidden twin", {
      publication_date: "2016",
      external_ids: [
        doi("10.5555/w.1"),
        { external_id_type: "eid", external_id_value: "E-LEAK", external_id_relationship: "self" },
      ],
      visibility: "private",
    }),
    work(3215, "Iota", { publication_date: "2022-03", external_ids: [doi("10.5555/i.1")] }),
    work(3216, "Kappa", { publication_date: "2022", external_ids: [doi("10.5555/k.1")] }),
    work(3217, "Lambda", {
      type: "report",
      publication_date: "2015",
      external_ids: [doi("10.5555/l.1")],
    }),
    work(3218, "Lambda", {
      type: "book",
      publication_date: "2015",
      external_ids: [doi("10.5555/l.2")],
    }),
    work(3219, "Mu B", { publication_date: "2014", external_ids: [doi("10.5555/m.1")] }),
    work(3220, "Mu A", { publication_date: "2014", external_ids: [doi("10.5555/m.2")] }),
    work(3221, "Nu", { external_ids: [doi("10.5555/n.1")] }),
  ],
  fundings: [
    {
      put_code: 3301,
      title: "Grant One",
      type: "grant",
      organization: FUNDER,
      external_ids: [grantId("GR-1")],
      visibility: "public",
      display_index: 0,
    },
    {
      put_code: 3302,
      title: "Grant One, renewed",
      type: "grant",
      organization: FUNDER,
      external_ids: [grantId("GR-1")],
      visibility: "public",
      display_index: 3,
    },
    {
      put_code: 3303,
      title: "Grant Two",
      type: "award",
      organization: FUNDER,
      visibility: "public",
      display_index: 1,
    },
    {
      put_code: 3304,
      title: "Grant Three",
      type: "contract",
      organization: FUNDER,
      external_ids: [grantId("GR-3"), grantId("FB-1", "funded-by")],
      visibility: "public",
      display_index: 1,
    },
    {
      put_code: 3305,
      title: "Grant hidden",
      type: "grant",
      organization: FUNDER,
      external_ids: [grantId("GR-3")],
      visibility: "private",
      display_index: 9,
    },
  ],
  peer_reviews: [
    review(3401, "issn:1111-1111", { completion_date: "2023-05-01", external_ids: [workId("A1")] }),
    review(3402, "issn:1111-1111", { completion_date: "2023-01-15", external_ids: [workId("A1")] }),
    review(3403, "issn:1111-1111", { completion_date: "2022-12-01", external_ids: [workId("B2")] }),
    review(3404, "issn:2222-2222", { completion_date: "2024-02-02", external_ids: [workId("C3")] }),
    review(3405, "issn:3333-3333", {}),
    review(3406, "issn:4444-4444", { completion_date: "2025-01-01", visibility: "private" }),
  ],
};

const nullFamily: FixtureUser = {
  orcid: IDS.nullFamily,
  name: { given_names: "Ondine", family_name: null, credit_name: null, visibility: "public" },
  // A private, unverified email: no verified email exists, so `history` says false for both.
  emails: [{ email: "ondine@example.test", primary: true, verified: false, visibility: "private" }],
};

const privateName: FixtureUser = {
  orcid: IDS.privateName,
  name: {
    given_names: "Bartholomew",
    family_name: "Quill",
    credit_name: null,
    visibility: "private",
  },
  biography: { content: "A public biography under a private name.", visibility: "public" },
  keywords: [{ put_code: 6001, content: "anonymity", visibility: "public" }],
};

const bioPrivate: FixtureUser = {
  orcid: IDS.bioPrivate,
  name: { given_names: "Lucan", family_name: "Ferreira", credit_name: null, visibility: "public" },
  biography: { content: "A biography nobody may read.", visibility: "private" },
  // A verified email that is not the primary one, and an unverified primary: `verified-email` is
  // true and `verified-primary-email` is false.
  emails: [
    { email: "lucan.primary@example.test", primary: true, verified: false, visibility: "private" },
    { email: "lucan.second@example.test", primary: false, verified: true, visibility: "private" },
  ],
};

const primary: FixtureUser = {
  orcid: IDS.primary,
  name: { given_names: "Primrose", family_name: "Aldous", credit_name: null, visibility: "public" },
};

const deprecated: FixtureUser = {
  orcid: IDS.deprecated,
  deprecated_to: IDS.primary,
  name: { given_names: "Primrose", family_name: "Aldous", credit_name: null, visibility: "public" },
};

const stateUser = (orcid: string, given: string, state: Partial<FixtureUser>): FixtureUser => ({
  orcid,
  name: { given_names: given, family_name: "Stateless", credit_name: null, visibility: "public" },
  ...state,
});

/** Hidden items in every section: a public name, and nothing else a public reader may see. */
const allPrivate: FixtureUser = {
  orcid: IDS.allPrivate,
  name: { given_names: "Ghost", family_name: "Reader", credit_name: null, visibility: "public" },
  other_names: [{ put_code: 4001, content: "Private alias", visibility: "private" }],
  emails: [
    { email: "ghost.reader@example.test", primary: true, verified: true, visibility: "limited" },
  ],
  addresses: [{ put_code: 4002, country: "NZ", visibility: "limited" }],
  keywords: [{ put_code: 4003, content: "private", visibility: "private" }],
  external_identifiers: [
    {
      put_code: 4004,
      external_id_type: "Loop profile",
      external_id_value: "x",
      visibility: "limited",
    },
  ],
  researcher_urls: [{ put_code: 4005, url: "https://example.test/ghost", visibility: "private" }],
  employments: [{ put_code: 4101, organization: HARTWELL, visibility: "private" }],
  educations: [{ put_code: 4102, organization: HARTWELL, visibility: "limited" }],
  qualifications: [{ put_code: 4103, organization: HARTWELL, visibility: "private" }],
  fundings: [
    {
      put_code: 4201,
      title: "Hidden grant",
      type: "grant",
      organization: FUNDER,
      visibility: "private",
    },
  ],
  peer_reviews: [
    {
      put_code: 4301,
      reviewer_role: "reviewer",
      review_type: "review",
      review_group_id: "issn:0000-0005",
      convening_organization: JOURNAL_BODY,
      visibility: "limited",
    },
  ],
  works: [
    {
      put_code: 4401,
      title: "Hidden work",
      type: "other",
      external_ids: [doi("10.5555/ghost.0001")],
      visibility: "private",
    },
  ],
};

export const RECORD_USERS_FILE: UsersFileInput = {
  clients: STARTER_USERS_FILE.clients,
  users: [
    carberry,
    rich,
    nullFamily,
    privateName,
    bioPrivate,
    allPrivate,
    grouping,
    primary,
    deprecated,
    stateUser(IDS.locked, "Lockhart", { locked: true }),
    stateUser(IDS.deactivated, "Deacon", { deactivated: true }),
    stateUser(IDS.unclaimed, "Unwin", { claimed: false }),
    stateUser(IDS.lockedDeactivated, "Lockdeac", { locked: true, deactivated: true }),
    stateUser(IDS.deprecatedLocked, "Deplock", { deprecated_to: IDS.primary, locked: true }),
    stateUser(IDS.unclaimedLocked, "Unlock", { claimed: false, locked: true }),
  ],
};
