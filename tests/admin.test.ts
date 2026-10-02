import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { isValidOrcidId } from "../src/orcid-id";
import { startTestServer, type TestServer } from "./harness";

interface FixtureUserBody {
  orcid: string;
  name: { given_names: string; family_name?: string | null };
  keywords?: Array<{ put_code: number; content: string }>;
  works?: Array<{ put_code: number }>;
  created_ms?: number;
}
interface Problem {
  error: string;
  issues?: Array<{ path: string; message: string }>;
}

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
}, 10_000);
beforeEach(() => server.reset());
afterAll(() => server.stop());

const person = (given: string, extra: Record<string, unknown> = {}) => ({
  name: { given_names: given, visibility: "public" },
  ...extra,
});
const email = (address: string, extra: Record<string, unknown> = {}) => ({
  email: address,
  primary: true,
  verified: true,
  visibility: "private",
  ...extra,
});

async function invalid(body: unknown, method = "POST", path = "/users") {
  const response = await server.admin<Problem>(method, path, body);
  expect(response.status).toBe(400);
  expect(response.body.error).toBe("invalid_fixture");
  return response.body.issues ?? [];
}

describe("health and users", () => {
  test("health counts the starter's users and clients", async () => {
    expect(await server.admin("GET", "/health")).toEqual({
      status: 200,
      body: { status: "ok", users: 3, clients: 2 },
    });
  });

  test("users come back in fixture form with minted iDs and put-codes, without stamps", async () => {
    const { status, body } = await server.admin<FixtureUserBody[]>("GET", "/users");
    expect(status).toBe(200);
    expect(body).toHaveLength(3);
    for (const user of body) {
      expect(isValidOrcidId(user.orcid)).toBe(true);
      expect(user.orcid.startsWith("0009-9")).toBe(true);
    }
    const [full] = body;
    expect(full?.name.given_names).toBe("Alder");
    expect(full?.keywords?.every((keyword) => keyword.put_code >= 1000)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("created_ms");
    expect(JSON.stringify(body)).not.toContain("modified_ms");
  });

  test("GET /users/:orcid returns that user and 404s for an unknown iD", async () => {
    const { body: all } = await server.admin<FixtureUserBody[]>("GET", "/users");
    const first = all[0] as FixtureUserBody;
    expect(await server.admin("GET", `/users/${first.orcid}`)).toEqual({
      status: 200,
      body: first,
    });
    expect(await server.admin("GET", "/users/0000-0002-1825-0097")).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });

  test("a user read from the API can be written back unchanged", async () => {
    const { body: all } = await server.admin<FixtureUserBody[]>("GET", "/users");
    for (const user of all) {
      const put = await server.admin<FixtureUserBody>("PUT", `/users/${user.orcid}`, user);
      expect(put.status).toBe(200);
      expect(put.body).toEqual(user);
    }
  });
});

describe("creating users", () => {
  test("POST without an orcid mints a valid iD in the mint block; a second POST of it is 409", async () => {
    const created = await server.admin<FixtureUserBody>("POST", "/users", person("Minted"));
    expect(created.status).toBe(201);
    expect(isValidOrcidId(created.body.orcid)).toBe(true);
    expect(created.body.orcid.startsWith("0009-9")).toBe(true);
    // The first runtime mint after a (re)load is pinned: seq 1 (see orcid-id.test.ts).
    expect(created.body.orcid).toBe("0009-9507-1056-7754");
    expect((await server.admin("GET", "/health")).body).toMatchObject({ users: 4 });

    const again = await server.admin(
      "POST",
      "/users",
      person("Other", { orcid: created.body.orcid }),
    );
    expect(again).toEqual({ status: 409, body: { error: "conflict" } });
    expect((await server.admin("GET", "/health")).body).toMatchObject({ users: 4 });
  });

  test("concurrent creates of one iD give exactly one 201 and the rest 409", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, n) =>
        server.admin("POST", "/users", person(`Racer${n}`, { orcid: "0000-0002-1825-0097" })),
      ),
    );
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect((await server.admin("GET", "/health")).body).toMatchObject({ users: 4 });
  });

  test("an empty orcid also mints, and two creates get different iDs", async () => {
    const a = await server.admin<FixtureUserBody>("POST", "/users", person("A", { orcid: "" }));
    const b = await server.admin<FixtureUserBody>("POST", "/users", person("A", { orcid: "" }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.orcid).not.toBe(b.body.orcid);
  });

  test("an explicit iD from any block is accepted", async () => {
    const created = await server.admin<FixtureUserBody>(
      "POST",
      "/users",
      person("Carberry", { orcid: "0000-0002-1825-0097" }),
    );
    expect(created.status).toBe(201);
    expect(created.body.orcid).toBe("0000-0002-1825-0097");
  });

  test("put-codes are assigned above the starter's, skipping explicit ones", async () => {
    const created = await server.admin<FixtureUserBody>(
      "POST",
      "/users",
      person("Coder", {
        keywords: [
          { put_code: 1017, content: "explicit", visibility: "public" },
          { content: "assigned", visibility: "public" },
        ],
      }),
    );
    expect(created.status).toBe(201);
    const codes = created.body.keywords?.map((keyword) => keyword.put_code);
    expect(codes?.[0]).toBe(1017);
    expect(codes?.[1]).toBeGreaterThan(1017);
  });

  test("a created user is listed and readable", async () => {
    const created = await server.admin<FixtureUserBody>("POST", "/users", person("Listed"));
    expect((await server.admin("GET", `/users/${created.body.orcid}`)).body).toEqual(created.body);
    const { body } = await server.admin<FixtureUserBody[]>("GET", "/users");
    expect(body.map((user) => user.orcid)).toContain(created.body.orcid);
  });
});

describe("upserting and deleting users", () => {
  const orcid = "0000-0002-1825-0097";

  test("PUT creates with 201, then replaces with 200", async () => {
    const created = await server.admin<FixtureUserBody>("PUT", `/users/${orcid}`, person("First"));
    expect(created.status).toBe(201);
    expect(created.body.orcid).toBe(orcid);

    const replaced = await server.admin<FixtureUserBody>(
      "PUT",
      `/users/${orcid}`,
      person("Second"),
    );
    expect(replaced.status).toBe(200);
    expect(
      (await server.admin<FixtureUserBody>("GET", `/users/${orcid}`)).body.name.given_names,
    ).toBe("Second");
    expect((await server.admin("GET", "/health")).body).toMatchObject({ users: 4 });
  });

  test("the path iD wins when the body has none, and a body iD that differs is 400", async () => {
    const issues = await invalid(
      person("Mismatch", { orcid: "0000-0001-5109-3700" }),
      "PUT",
      `/users/${orcid}`,
    );
    expect(issues.map((issue) => issue.path)).toEqual(["orcid"]);
    expect((await server.admin("GET", `/users/${orcid}`)).status).toBe(404);

    const same = await server.admin("PUT", `/users/${orcid}`, person("Same", { orcid }));
    expect(same.status).toBe(201);
  });

  test("a path that is not a valid iD is 400", async () => {
    const issues = await invalid(person("Bad"), "PUT", "/users/0000-0002-1825-0098");
    expect(issues.map((issue) => issue.path)).toEqual(["orcid"]);
    expect((await invalid(person("Bad"), "PUT", "/users/nope")).map((issue) => issue.path)).toEqual(
      ["orcid"],
    );
  });

  test("DELETE is 204, then 404", async () => {
    const { body } = await server.admin<FixtureUserBody[]>("GET", "/users");
    const target = (body[1] as FixtureUserBody).orcid;
    expect(await server.admin("DELETE", `/users/${target}`)).toEqual({
      status: 204,
      body: undefined,
    });
    expect((await server.admin("GET", `/users/${target}`)).status).toBe(404);
    expect(await server.admin("DELETE", `/users/${target}`)).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    expect((await server.admin("GET", "/health")).body).toMatchObject({ users: 2 });
  });
});

describe("deprecation through the API", () => {
  const [a, b, c] = ["0000-0002-1825-0097", "0000-0001-5109-3700", "0000-0002-1694-233X"] as const;

  test("a record cannot be deprecated to the iD in its own path", async () => {
    const issues = await invalid(person("Self", { deprecated_to: a }), "PUT", `/users/${a}`);
    expect(issues.map((issue) => issue.path)).toEqual(["deprecated_to"]);
    expect((await server.admin("GET", `/users/${a}`)).status).toBe(404);
  });

  test("a cycle against the stored users is rejected, at any length", async () => {
    expect(
      (await server.admin("PUT", `/users/${a}`, person("A", { deprecated_to: b }))).status,
    ).toBe(201);
    expect(
      (await server.admin("PUT", `/users/${b}`, person("B", { deprecated_to: c }))).status,
    ).toBe(201);
    const issues = await invalid(person("C", { deprecated_to: a }), "PUT", `/users/${c}`);
    expect(issues.map((issue) => issue.path)).toEqual(["deprecated_to"]);
    expect(issues[0]?.message).toContain("cycle");
    expect((await server.admin("GET", `/users/${c}`)).status).toBe(404);

    // Without the back edge the chain is fine, and replacing A so it stops deprecating is too.
    expect((await server.admin("PUT", `/users/${c}`, person("C"))).status).toBe(201);
    expect((await server.admin("PUT", `/users/${a}`, person("A again"))).status).toBe(200);
  });

  test("replacing a user does not count its old deprecation against the new one", async () => {
    await server.admin("PUT", `/users/${a}`, person("A", { deprecated_to: b }));
    await server.admin("PUT", `/users/${b}`, person("B"));
    // B now deprecates to A: A -> B is stored, so this is a cycle.
    await invalid(person("B", { deprecated_to: a }), "PUT", `/users/${b}`);
    // Re-pointing A elsewhere removes the old edge, so B -> A is fine afterwards.
    await server.admin("PUT", `/users/${a}`, person("A", { deprecated_to: c }));
    expect(
      (await server.admin("PUT", `/users/${b}`, person("B", { deprecated_to: a }))).status,
    ).toBe(200);
  });
});

describe("clients", () => {
  test("GET /clients lists the starter's clients and GET /clients/:id reads one", async () => {
    const list = await server.admin<Array<{ client_id: string }>>("GET", "/clients");
    expect(list.status).toBe(200);
    expect(list.body.map((client) => client.client_id)).toEqual([
      "APP-ORCIDMOCK000001",
      "APP-ORCIDMOCK000002",
    ]);
    expect(list.body[0] as unknown).toEqual({
      client_id: "APP-ORCIDMOCK000001",
      client_secret: "orcid-mock-secret",
      name: "orcid-mock public client",
      redirect_uris: ["http://localhost:3000/callback", "http://127.0.0.1:3000/callback"],
      member: false,
    });
    expect((await server.admin("GET", "/clients/APP-ORCIDMOCK000002")).body).toEqual(list.body[1]);
    expect(await server.admin("GET", "/clients/APP-NOPE")).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });

  test("a client read from the API can be written back unchanged", async () => {
    const { body } = await server.admin<Array<{ client_id: string }>>("GET", "/clients");
    for (const client of body) {
      const put = await server.admin("PUT", `/clients/${client.client_id}`, client);
      expect(put).toEqual({ status: 200, body: client });
    }
  });

  test("PUT creates with 201 and replaces with 200; the path id wins", async () => {
    const client = {
      client_secret: "secret",
      name: "Under test",
      redirect_uris: ["http://localhost:51234/callback"],
      member: true,
    };
    const created = await server.admin("PUT", "/clients/APP-UNDERTEST", client);
    expect(created).toEqual({ status: 201, body: { client_id: "APP-UNDERTEST", ...client } });
    expect((await server.admin("GET", "/health")).body).toMatchObject({ clients: 3 });

    const replaced = await server.admin("PUT", "/clients/APP-UNDERTEST", {
      ...client,
      client_id: "APP-UNDERTEST",
      redirect_uris: ["http://localhost:60000/callback"],
    });
    expect(replaced.status).toBe(200);
    expect((await server.admin("GET", "/health")).body).toMatchObject({ clients: 3 });
  });

  test("a client body that is not an object is an invalid fixture at the root", async () => {
    for (const body of [null, [], "text"]) {
      const issues = await invalid(body, "PUT", "/clients/APP-X");
      expect(issues.map((issue) => issue.path)).toEqual([""]);
    }
  });

  test("defaults fill the name and member flag", async () => {
    const created = await server.admin("PUT", "/clients/APP-PLAIN", {
      client_secret: "s",
      redirect_uris: ["http://localhost/cb"],
    });
    expect(created.body).toEqual({
      client_id: "APP-PLAIN",
      client_secret: "s",
      name: "APP-PLAIN",
      redirect_uris: ["http://localhost/cb"],
      member: false,
    });
  });

  test("a body client_id that differs from the path is 400, and bad bodies name their path", async () => {
    const issues = await invalid(
      { client_id: "APP-OTHER", client_secret: "s", redirect_uris: ["http://localhost/cb"] },
      "PUT",
      "/clients/APP-ONE",
    );
    expect(issues.map((issue) => issue.path)).toEqual(["client_id"]);
    expect(
      (
        await invalid(
          { client_secret: "s", redirect_uris: ["not a url"] },
          "PUT",
          "/clients/APP-ONE",
        )
      ).map((issue) => issue.path),
    ).toEqual(["redirect_uris[0]"]);
    expect(
      (await invalid({ client_secret: "s", redirect_uris: [] }, "PUT", "/clients/APP-ONE")).map(
        (issue) => issue.path,
      ),
    ).toEqual(["redirect_uris"]);
  });
});

describe("reset", () => {
  test("undoes creates, deletes, replaces, and client changes, and restores the starter iDs", async () => {
    const before = (await server.admin<FixtureUserBody[]>("GET", "/users")).body;
    const clientsBefore = (await server.admin("GET", "/clients")).body;

    const minted = await server.admin<FixtureUserBody>("POST", "/users", person("Transient"));
    await server.admin("DELETE", `/users/${(before[0] as FixtureUserBody).orcid}`);
    await server.admin("PUT", `/users/${(before[1] as FixtureUserBody).orcid}`, person("Replaced"));
    await server.admin("PUT", "/clients/APP-TRANSIENT", {
      client_secret: "s",
      redirect_uris: ["http://localhost/cb"],
    });
    await server.admin("PUT", "/clients/APP-ORCIDMOCK000001", {
      client_secret: "changed",
      redirect_uris: ["http://localhost:9/changed"],
      member: true,
    });
    expect((await server.admin("GET", "/health")).body).toEqual({
      status: "ok",
      users: 3,
      clients: 3,
    });

    const reset = await server.admin("POST", "/reset");
    expect(reset).toEqual({ status: 200, body: { status: "ok", users: 3, clients: 2 } });
    expect((await server.admin("GET", "/users")).body).toEqual(before);
    expect((await server.admin("GET", "/clients")).body).toEqual(clientsBefore);
    expect((await server.admin("GET", "/clients/APP-TRANSIENT")).status).toBe(404);
    expect((await server.admin("GET", `/users/${minted.body.orcid}`)).status).toBe(404);

    // The mint counter is back at its baseline, so the same create mints the same iD.
    const again = await server.admin<FixtureUserBody>("POST", "/users", person("Transient"));
    expect(again.body.orcid).toBe(minted.body.orcid);
  });

  test("put-codes assigned after a reset start from the baseline counter again", async () => {
    const first = await server.admin<FixtureUserBody>(
      "POST",
      "/users",
      person("P", { works: [{ title: "w", type: "journal-article", visibility: "public" }] }),
    );
    await server.admin("POST", "/reset");
    const second = await server.admin<FixtureUserBody>(
      "POST",
      "/users",
      person("P", { works: [{ title: "w", type: "journal-article", visibility: "public" }] }),
    );
    expect(second.body.works?.[0]?.put_code).toBe(first.body.works?.[0]?.put_code as number);
  });
});

describe("bad requests", () => {
  const raw = (path: string, init: RequestInit) => fetch(`${server.baseUrl}/__admin${path}`, init);

  test("malformed JSON is 400 invalid_request, never 500", async () => {
    for (const body of ["{", "not json", '{"name":']) {
      const response = await raw("/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
  });

  test("an empty body and a wrong or missing Content-Type are 400 invalid_request", async () => {
    const cases: RequestInit[] = [
      { method: "POST", headers: { "content-type": "application/json" }, body: "" },
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(person("X")),
      },
      { method: "POST", body: JSON.stringify(person("X")) },
      {
        method: "PUT",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=b",
      },
    ];
    for (const init of cases) {
      const path = init.method === "PUT" ? "/clients/APP-X" : "/users";
      const response = await raw(path, init);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
  });

  test("a JSON Content-Type with a charset is accepted", async () => {
    const response = await raw("/users", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(person("Charset")),
    });
    expect(response.status).toBe(201);
  });

  test("a body that is not an object is an invalid fixture at the root", async () => {
    for (const body of [null, [], "text", 7]) {
      const issues = await invalid(body);
      expect(issues.map((issue) => issue.path)).toEqual([""]);
    }
  });
});

describe("fixture refinements through the API", () => {
  test("a bad checksum names orcid", async () => {
    const issues = await invalid(person("A", { orcid: "0000-0002-1825-0098" }));
    expect(issues.map((issue) => issue.path)).toEqual(["orcid"]);
    expect(issues[0]?.message).toContain("check character");
  });

  test("a malformed iD names orcid", async () => {
    expect((await invalid(person("A", { orcid: "12345" }))).map((issue) => issue.path)).toEqual([
      "orcid",
    ]);
  });

  test("an email duplicated in a different case names the email", async () => {
    const issues = await invalid(person("A", { emails: [email("ALDER.FENNIMORE@Example.TEST")] }));
    expect(issues.map((issue) => issue.path)).toEqual(["emails[0].email"]);
  });

  test("a public email that is not verified names its visibility", async () => {
    const issues = await invalid(
      person("A", { emails: [email("a@example.test", { verified: false, visibility: "public" })] }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(["emails[0].visibility"]);
  });

  test("two primary emails, and none, name the list", async () => {
    const two = await invalid(
      person("A", { emails: [email("a@example.test"), email("b@example.test")] }),
    );
    expect(two.map((issue) => issue.path)).toEqual(["emails"]);
    const none = await invalid(
      person("A", { emails: [email("a@example.test", { primary: false })] }),
    );
    expect(none.map((issue) => issue.path)).toEqual(["emails"]);
  });

  test("a put-code repeated within a section names the repeat, in one user or across users", async () => {
    const within = await invalid(
      person("A", {
        keywords: [
          { put_code: 5000, content: "one", visibility: "public" },
          { put_code: 5000, content: "two", visibility: "public" },
        ],
      }),
    );
    expect(within.map((issue) => issue.path)).toEqual(["keywords[1].put_code"]);

    const first = await server.admin(
      "POST",
      "/users",
      person("Holder", { keywords: [{ put_code: 5001, content: "k", visibility: "public" }] }),
    );
    expect(first.status).toBe(201);
    const across = await invalid(
      person("B", { keywords: [{ put_code: 5001, content: "k", visibility: "public" }] }),
    );
    expect(across.map((issue) => issue.path)).toEqual(["keywords[0].put_code"]);

    // The same put-code in a different section is fine.
    const other = await server.admin(
      "POST",
      "/users",
      person("C", { other_names: [{ put_code: 5001, content: "n", visibility: "public" }] }),
    );
    expect(other.status).toBe(201);
  });

  test("an email already held by another stored user is rejected", async () => {
    const { body } = await server.admin<
      Array<FixtureUserBody & { emails?: Array<{ email: string }> }>
    >("GET", "/users");
    const holder = body[0] as FixtureUserBody & { emails: Array<{ email: string }> };
    const issues = await invalid(
      person("Thief", { emails: [email(holder.emails[0]?.email as string)] }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(["emails[0].email"]);
  });

  test("a typo in a key is reported at its object", async () => {
    const issues = await invalid({
      name: { given_names: "A", familyname: "B", visibility: "public" },
    });
    expect(issues.map((issue) => issue.path)).toEqual(["name"]);
    expect(issues[0]?.message).toContain("familyname");
  });

  test("a year outside 1900 to 2100 names the date", async () => {
    const issues = await invalid(
      person("A", {
        employments: [
          {
            organization: { name: "O", address: { city: "C", country: "NZ" } },
            start_date: "1843-01",
            visibility: "public",
          },
        ],
      }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(["employments[0].start_date"]);
  });

  test("every rule that fails is reported at once, structure problems first", async () => {
    const rules = await invalid({
      orcid: "0000-0002-1825-0098",
      name: { given_names: "A", visibility: "public" },
      emails: [
        email("x@example.test", { verified: false, visibility: "public" }),
        email("y@example.test"),
      ],
    });
    expect(rules.map((issue) => issue.path).sort()).toEqual(
      ["emails", "emails[0].visibility", "orcid"].sort(),
    );

    // A structural problem (here an unknown visibility) is reported alone: rules run only on a
    // structurally valid user.
    const structure = await invalid({
      orcid: "0000-0002-1825-0098",
      name: { given_names: "A", visibility: "secret" },
    });
    expect(structure.map((issue) => issue.path)).toEqual(["name.visibility"]);
  });
});

describe("starting with a bad fixture", () => {
  test("a duplicate iD in the users file refuses to start and names the path", async () => {
    const dup = {
      clients: [],
      users: [
        person("A", { orcid: "0000-0002-1825-0097" }),
        person("B", { orcid: "0000-0002-1825-0097" }),
      ],
    };
    await expect(startTestServer({ users: dup })).rejects.toThrow("users[1].orcid");
  });
});

describe("cross-origin protection", () => {
  const withOrigin = (origin: string, path: string, method = "GET", body?: unknown) =>
    fetch(`${server.baseUrl}/__admin${path}`, {
      method,
      headers: {
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("a foreign Origin is refused on every method, and nothing changes", async () => {
    const created = await server.admin<FixtureUserBody>("POST", "/users", person("Guarded"));
    const evil = "https://evil.example.test";
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", "/health"],
      ["GET", "/users"],
      ["GET", "/clients"],
      ["POST", "/reset"],
      ["POST", "/users", person("Intruder")],
      ["PUT", `/users/${created.body.orcid}`, person("Overwritten")],
      ["DELETE", `/users/${created.body.orcid}`],
      ["PUT", "/clients/APP-EVIL", { client_secret: "s", redirect_uris: ["http://evil.test/cb"] }],
    ];
    for (const [method, path, body] of attempts) {
      const response = await withOrigin(evil, path, method, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden_origin" });
    }
    expect((await server.admin("GET", "/health")).body).toEqual({
      status: "ok",
      users: 4,
      clients: 2,
    });
    expect(
      (await server.admin<FixtureUserBody>("GET", `/users/${created.body.orcid}`)).body.name,
    ).toMatchObject({
      given_names: "Guarded",
    });
  });

  test("an opaque Origin of null is refused too", async () => {
    expect((await withOrigin("null", "/health")).status).toBe(403);
  });

  test("the server's own origin is allowed, and so is no Origin at all", async () => {
    expect((await withOrigin(server.publicBaseUrl, "/health")).status).toBe(200);
    expect((await withOrigin(server.publicBaseUrl, "/reset", "POST")).status).toBe(200);
    expect((await server.admin("GET", "/health")).status).toBe(200);
  });

  test("the rule only guards /__admin", async () => {
    const response = await fetch(`${server.baseUrl}/v3.0/nope`, {
      headers: { origin: "https://evil.example.test" },
    });
    expect(response.status).toBe(404);
  });

  test("the allowed origin is the public base URL's, whatever its path prefix", async () => {
    const proxied = await startTestServer({ publicBaseUrl: "https://orcid.example.test/mock/" });
    try {
      const get = (origin: string) =>
        fetch(`${proxied.baseUrl}/__admin/health`, { headers: { origin } });
      expect((await get("https://orcid.example.test")).status).toBe(200);
      expect((await get("https://orcid.example.test:8443")).status).toBe(403);
      expect((await get(proxied.baseUrl)).status).toBe(403);
    } finally {
      await proxied.stop();
    }
  });
});
