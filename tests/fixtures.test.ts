import { describe, expect, test } from "bun:test";
import { parseUsersFile } from "../src/fixtures/load";
import { usersFileJsonSchema, usersFileJsonSchemaText } from "../src/fixtures/schema";
import { STARTER_USERS_FILE, starterFixtureJson } from "../src/fixtures/starter";
import { isValidOrcidId } from "../src/orcid-id";

const fixturesDir = `${import.meta.dir}/../fixtures`;

function load(input: unknown, nowMs = 1_000) {
  const result = parseUsersFile(input, nowMs);
  if (!result.ok) throw new Error(`fixture rejected: ${JSON.stringify(result.issues)}`);
  return result.snapshot;
}

const org = { name: "Example Org", address: { city: "Wellington", country: "NZ" } };

function userNamed(given: string, extra: Record<string, unknown> = {}) {
  return { name: { given_names: given, visibility: "public" }, ...extra };
}

describe("the starter fixture", () => {
  test("loads with three users, two clients, and valid minted iDs", () => {
    const snapshot = load(STARTER_USERS_FILE);
    expect(snapshot.users).toHaveLength(3);
    expect(snapshot.clients.map((client) => client.client_id)).toEqual([
      "APP-ORCIDMOCK000001",
      "APP-ORCIDMOCK000002",
    ]);
    expect(snapshot.clients.map((client) => client.member)).toEqual([false, true]);
    for (const user of snapshot.users) {
      expect(isValidOrcidId(user.orcid)).toBe(true);
      expect(user.orcid.startsWith("0009-9")).toBe(true);
    }
  });

  test("minted iDs are stable across two loads", () => {
    const first = load(STARTER_USERS_FILE, 1_000).users.map((user) => user.orcid);
    const second = load(STARTER_USERS_FILE, 9_999).users.map((user) => user.orcid);
    expect(second).toEqual(first);
  });

  test("covers every section, grouping, and every visibility", () => {
    const [full] = load(STARTER_USERS_FILE).users;
    expect(full).toBeDefined();
    const user = full as NonNullable<typeof full>;
    for (const section of [
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
    ] as const) {
      expect((user[section] ?? []).length).toBeGreaterThan(0);
    }
    const dois = (user.works ?? []).flatMap((work) =>
      (work.external_ids ?? []).filter((id) => id.external_id_type === "doi"),
    );
    const shared = dois.filter((id) => id.external_id_value === "10.5555/orcid-mock.0001");
    expect(shared.length).toBeGreaterThanOrEqual(2);
    const visibilities = JSON.stringify(user).match(/"visibility":"(\w+)"/g) ?? [];
    expect(visibilities).toContain('"visibility":"limited"');
    expect(visibilities).toContain('"visibility":"private"');
  });

  test("the second user has no family name and the third is private and locked", () => {
    const [, second, third] = load(STARTER_USERS_FILE).users;
    expect(second?.name.family_name).toBeNull();
    expect(second?.emails?.[0]?.verified).toBe(false);
    expect(third?.name.visibility).toBe("private");
    expect(third?.locked).toBe(true);
  });
});

describe("minting", () => {
  test("adding a user before an existing one does not change the existing iD", () => {
    const alone = load({ clients: [], users: [userNamed("Zed", { orcid: "" })] });
    const after = load({
      clients: [],
      users: [userNamed("Newcomer"), userNamed("Zed", { orcid: "" })],
    });
    expect(after.users[1]?.orcid).toBe(alone.users[0]?.orcid as string);
    expect(after.users[0]?.orcid).not.toBe(after.users[1]?.orcid);
  });

  test("explicit iDs from any block are kept and reserved before minting", () => {
    const snapshot = load({
      clients: [],
      users: [userNamed("Carberry", { orcid: "0000-0002-1825-0097" }), userNamed("Other")],
    });
    expect(snapshot.users[0]?.orcid).toBe("0000-0002-1825-0097");
    expect(snapshot.users[1]?.orcid.startsWith("0009-9")).toBe(true);
  });

  test("two users with the same identity still get different iDs", () => {
    const snapshot = load({ clients: [], users: [userNamed("Twin"), userNamed("Twin")] });
    expect(snapshot.users[0]?.orcid).not.toBe(snapshot.users[1]?.orcid);
    expect(snapshot.users.every((user) => isValidOrcidId(user.orcid))).toBe(true);
  });

  test("the primary email feeds the seed, case-insensitively", () => {
    const withEmail = (email: string) =>
      load({
        clients: [],
        users: [
          userNamed("Same", {
            emails: [{ email, primary: true, verified: true, visibility: "private" }],
          }),
        ],
      }).users[0]?.orcid;
    expect(withEmail("Same@Example.test")).toBe(withEmail("same@example.test"));
    expect(withEmail("same@example.test")).not.toBe(withEmail("other@example.test"));
  });
});

describe("put-codes and stamps", () => {
  const input = {
    clients: [],
    users: [
      userNamed("Keeper", {
        keywords: [
          { put_code: 2500, content: "kept", visibility: "public" },
          { content: "assigned", visibility: "public" },
        ],
        employments: [{ organization: org, visibility: "public" }],
      }),
      userNamed("Second", { keywords: [{ content: "also assigned", visibility: "public" }] }),
    ],
  };

  test("explicit put-codes are kept and missing ones are assigned above the maximum", () => {
    const snapshot = load(input, 4_242);
    const [first, second] = snapshot.users;
    expect(first?.keywords?.[0]?.put_code).toBe(2500);
    expect(first?.keywords?.[1]?.put_code).toBe(2501);
    expect(first?.employments?.[0]?.put_code).toBe(2502);
    expect(second?.keywords?.[0]?.put_code).toBe(2503);
    expect(snapshot.next_put_code).toBe(2504);
    expect(snapshot.next_mint_seq).toBe(1);
  });

  test("the counter starts at 1000 when no fixture put-code is higher", () => {
    const snapshot = load({
      clients: [],
      users: [
        userNamed("Low", { keywords: [{ put_code: 7, content: "k", visibility: "public" }] }),
        userNamed("Low2", { keywords: [{ content: "k", visibility: "public" }] }),
      ],
    });
    expect(snapshot.users[1]?.keywords?.[0]?.put_code).toBe(1000);
  });

  test("created and modified times are stamped on every dated piece", () => {
    const snapshot = load(
      {
        clients: [],
        users: [
          userNamed("Dated", {
            biography: { content: "bio", visibility: "public" },
            emails: [
              { email: "d@example.test", primary: true, verified: true, visibility: "private" },
            ],
            keywords: [{ content: "k", visibility: "public" }],
          }),
        ],
      },
      4_242,
    );
    const user = snapshot.users[0];
    for (const dated of [user?.name, user?.biography, user?.emails?.[0], user?.keywords?.[0]]) {
      expect(dated).toMatchObject({ created_ms: 4_242, modified_ms: 4_242 });
    }
  });

  test("client defaults: name is the client_id and member is false", () => {
    const snapshot = load({
      clients: [{ client_id: "APP-X", client_secret: "s", redirect_uris: ["http://localhost/cb"] }],
      users: [],
    });
    expect(snapshot.clients[0]).toEqual({
      client_id: "APP-X",
      client_secret: "s",
      name: "APP-X",
      redirect_uris: ["http://localhost/cb"],
      member: false,
    });
  });
});

describe("rejections", () => {
  const paths = (input: unknown) => {
    const result = parseUsersFile(input, 0);
    return result.ok ? [] : result.issues.map((issue) => issue.path);
  };

  test("a bad checksum and a duplicate iD name the offending user", () => {
    expect(
      paths({ clients: [], users: [userNamed("A", { orcid: "0000-0002-1825-0098" })] }),
    ).toEqual(["users[0].orcid"]);
    expect(
      paths({
        clients: [],
        users: [
          userNamed("A", { orcid: "0000-0002-1825-0097" }),
          userNamed("B", { orcid: "0000-0002-1825-0097" }),
        ],
      }),
    ).toEqual(["users[1].orcid"]);
  });

  test("a record deprecated to itself is rejected", () => {
    const self = "0000-0002-1825-0097";
    expect(
      paths({ clients: [], users: [userNamed("A", { orcid: self, deprecated_to: self })] }),
    ).toEqual(["users[0].deprecated_to"]);
  });

  test("a dotted and bracketed path reaches into a nested section", () => {
    expect(
      paths({
        clients: [],
        users: [
          userNamed("A"),
          userNamed("B", {
            works: [{ title: "t", type: "Journal Article", visibility: "public" }],
          }),
        ],
      }),
    ).toEqual(["users[1].works[0].type"]);
  });
});

describe("the committed JSON files", () => {
  test("usersFileJsonSchema() deep-equals fixtures/users.schema.json", async () => {
    const committed = await Bun.file(`${fixturesDir}/users.schema.json`).text();
    expect(JSON.parse(committed)).toEqual(usersFileJsonSchema());
    expect(committed).toBe(usersFileJsonSchemaText());
  });

  test("fixtures/users.example.json is the serialized starter and loads", async () => {
    const committed = await Bun.file(`${fixturesDir}/users.example.json`).text();
    expect(committed).toBe(starterFixtureJson());
    const parsed = JSON.parse(committed);
    expect(parsed.$schema).toBe("./users.schema.json");
    expect(Object.keys(parsed)[0]).toBe("$schema");
    expect(load(parsed).users).toHaveLength(3);
  });

  test("the generated schema is strict and documents the file's top level", () => {
    const schema = usersFileJsonSchema() as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["clients", "users"]);
    expect(Object.keys(schema.properties)).toEqual(["$schema", "clients", "users"]);
  });
});
