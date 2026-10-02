// The bundled default fixture, served when USERS_FILE is unset and written by `orcid-mock fixture`.
// Every name is invented; the example iD in a work's contributor is ORCID's own fictional demo
// record (Josiah Carberry). `orcid` is left empty so each user's iD is minted deterministically.
import type { UsersFileInput } from "./schema";

const WELLINGTON = {
  name: "Example Institute for Brain Data",
  address: { city: "Wellington", region: "Wellington", country: "NZ" },
  disambiguated_organization: {
    disambiguated_organization_identifier: "https://ror.org/00test0000",
    disambiguation_source: "ROR",
  },
};

export const STARTER_USERS_FILE: UsersFileInput = {
  clients: [
    {
      client_id: "APP-ORCIDMOCK000001",
      client_secret: "orcid-mock-secret",
      name: "orcid-mock public client",
      redirect_uris: ["http://localhost:3000/callback", "http://127.0.0.1:3000/callback"],
      member: false,
    },
    {
      client_id: "APP-ORCIDMOCK000002",
      client_secret: "orcid-mock-secret",
      name: "orcid-mock member client",
      redirect_uris: ["http://localhost:3000/callback", "http://127.0.0.1:3000/callback"],
      member: true,
    },
  ],
  users: [
    {
      orcid: "",
      password: "test",
      name: {
        given_names: "Alder",
        family_name: "Fennimore",
        credit_name: "A. Fennimore",
        visibility: "public",
      },
      other_names: [
        { content: "A. L. Fennimore", visibility: "public" },
        { content: "Alder Fennimore-Hale", visibility: "limited" },
      ],
      biography: {
        content: "A fictional researcher who exists only to exercise orcid-mock.",
        visibility: "public",
      },
      emails: [
        {
          email: "alder.fennimore@example.test",
          primary: true,
          verified: true,
          visibility: "public",
        },
        {
          email: "alder.private@example.test",
          primary: false,
          verified: true,
          visibility: "private",
        },
      ],
      addresses: [{ country: "NZ", visibility: "public" }],
      keywords: [
        { content: "electroencephalography", visibility: "public" },
        { content: "research data standards", visibility: "public" },
        { content: "unpublished idea", visibility: "private" },
      ],
      external_identifiers: [
        {
          external_id_type: "Scopus Author ID",
          external_id_value: "55500000001",
          external_id_url: "https://example.test/scopus/55500000001",
          external_id_relationship: "self",
          visibility: "public",
        },
      ],
      researcher_urls: [
        { url_name: "Lab website", url: "https://example.test/fennimore", visibility: "public" },
      ],
      employments: [
        {
          department_name: "Neuroinformatics",
          role_title: "Research Scientist",
          start_date: "2019-09",
          end_date: null,
          organization: WELLINGTON,
          url: "https://example.test/institute",
          visibility: "public",
        },
      ],
      educations: [
        {
          department_name: "Department of Cognitive Science",
          role_title: "Doctor of Philosophy",
          start_date: "2012-02",
          end_date: "2016-12-15",
          organization: {
            name: "Example University of Wellington",
            address: { city: "Wellington", country: "NZ" },
          },
          visibility: "public",
        },
      ],
      qualifications: [
        {
          role_title: "Certified Data Steward",
          start_date: "2021",
          organization: WELLINGTON,
          visibility: "public",
        },
      ],
      works: [
        {
          title: "A Fictional Study of Fictional Signals",
          subtitle: "Evidence from an invented dataset",
          journal_title: "Journal of Imaginary Neuroscience",
          short_description: "A journal article that shares its DOI with the preprint below.",
          type: "journal-article",
          publication_date: "2022-03-14",
          external_ids: [
            {
              external_id_type: "doi",
              external_id_value: "10.5555/orcid-mock.0001",
              external_id_url: "https://doi.org/10.5555/orcid-mock.0001",
              external_id_relationship: "self",
            },
          ],
          url: "https://doi.org/10.5555/orcid-mock.0001",
          contributors: [
            {
              credit_name: "Alder Fennimore",
              contributor_sequence: "first",
              contributor_role: "author",
            },
            {
              contributor_orcid: "0000-0002-1825-0097",
              credit_name: "Josiah Carberry",
              contributor_sequence: "additional",
              contributor_role: "author",
            },
          ],
          language_code: "en",
          country: "NZ",
          visibility: "public",
        },
        {
          title: "A Fictional Study of Fictional Signals",
          journal_title: "Preprint Server of Imaginary Results",
          type: "preprint",
          publication_date: "2021-11",
          external_ids: [
            {
              external_id_type: "doi",
              external_id_value: "10.5555/orcid-mock.0001",
              external_id_url: "https://doi.org/10.5555/orcid-mock.0001",
              external_id_relationship: "self",
            },
          ],
          visibility: "public",
        },
        {
          title: "Pilot recordings (shared with trusted parties)",
          type: "data-set",
          publication_date: "2020",
          external_ids: [
            {
              external_id_type: "doi",
              external_id_value: "10.5555/orcid-mock.0002",
              external_id_relationship: "self",
            },
          ],
          visibility: "limited",
        },
      ],
      fundings: [
        {
          title: "Fictional Signals Initiative",
          type: "grant",
          start_date: "2020-01",
          end_date: "2023-12",
          organization: {
            name: "Example Science Foundation",
            address: { city: "Auckland", country: "NZ" },
          },
          external_ids: [
            {
              external_id_type: "grant_number",
              external_id_value: "EXF-2020-001",
              external_id_relationship: "self",
            },
          ],
          visibility: "public",
        },
        {
          title: "Confidential fellowship",
          type: "award",
          start_date: "2024",
          organization: {
            name: "Example Science Foundation",
            address: { city: "Auckland", country: "NZ" },
          },
          visibility: "private",
        },
      ],
      peer_reviews: [
        {
          reviewer_role: "reviewer",
          review_type: "review",
          review_group_id: "issn:0000-0000",
          completion_date: "2023-06-01",
          convening_organization: {
            name: "Journal of Imaginary Neuroscience",
            address: { city: "Wellington", country: "NZ" },
          },
          visibility: "public",
        },
      ],
    },
    {
      orcid: "",
      password: "test",
      name: { given_names: "Sennet", family_name: null, credit_name: null, visibility: "public" },
      emails: [
        { email: "sennet@example.test", primary: true, verified: false, visibility: "private" },
      ],
    },
    {
      orcid: "",
      password: "test",
      locked: true,
      name: {
        given_names: "Briar",
        family_name: "Ashgrove",
        credit_name: null,
        visibility: "private",
      },
    },
  ],
};

/** The starter as the JSON file `orcid-mock fixture` writes and fixtures/users.example.json holds. */
export function starterFixtureJson(): string {
  return `${JSON.stringify({ $schema: "./users.schema.json", ...STARTER_USERS_FILE }, null, 2)}\n`;
}
