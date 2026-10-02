// The Testcontainers module against a real container, and the client against what it starts.
// One container serves the whole file, and every test starts from a reset mock.
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcidMockError, type OrcidMockUser } from "../src/client";
import { OrcidMockContainer, type StartedOrcidMockContainer } from "../src/testcontainers";

setDefaultTimeout(120_000);

let mock: StartedOrcidMockContainer;

beforeAll(async () => {
  mock = await new OrcidMockContainer().start();
}, 180_000);

afterAll(async () => {
  await mock?.stop();
});

beforeEach(async () => {
  await mock.client.reset();
});

const newUser = (given: string, email: string): OrcidMockUser => ({
  name: { given_names: given, family_name: "Tester", visibility: "public" },
  emails: [{ email, primary: true, verified: true, visibility: "public" }],
});

describe("OrcidMockContainer", () => {
  test("starts on a published port and exposes its base URL and a ready client", async () => {
    expect(mock.baseUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(mock.client.baseUrl).toBe(mock.baseUrl);
    expect(await mock.client.health()).toEqual({ status: "ok", users: 3, clients: 2 });
    expect(mock.getMappedPort(9700)).toBe(Number(new URL(mock.baseUrl).port));
  });

  test("the mock believes it is at the published address, never the container's", async () => {
    // The consent page's form posts back to a URL built from PUBLIC_BASE_URL.
    const page = await fetch(
      `${mock.baseUrl}/oauth/authorize?client_id=APP-ORCIDMOCK000001&response_type=code&scope=/authenticate&redirect_uri=http://localhost:3000/callback`,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`action="${mock.baseUrl}/oauth/authorize"`);
  });

  test("serves a users object given with withUsers", async () => {
    const custom = await new OrcidMockContainer()
      .withUsers({
        clients: [],
        users: [{ ...newUser("Only", "only@example.test"), orcid: "0000-0002-1825-0097" }],
      })
      .start();
    try {
      expect(await custom.client.health()).toEqual({ status: "ok", users: 1, clients: 0 });
      expect((await custom.client.user("0000-0002-1825-0097")).name.given_names).toBe("Only");
    } finally {
      await custom.stop();
    }
  });

  test("serves a users file given by path, whatever its permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orcid-mock-users-"));
    try {
      const path = join(dir, "users.json");
      await writeFile(
        path,
        JSON.stringify({
          clients: [],
          users: [{ ...newUser("Filed", "filed@example.test"), orcid: "0000-0001-5109-3700" }],
        }),
        { mode: 0o600 },
      );
      const custom = await new OrcidMockContainer().withUsers(path).start();
      try {
        expect((await custom.client.users()).map((user) => user.orcid)).toEqual([
          "0000-0001-5109-3700",
        ]);
      } finally {
        await custom.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a users file the server rejects fails start with the server's own message", async () => {
    const container = new OrcidMockContainer().withUsers({
      clients: [],
      users: [{ ...newUser("Bad", "bad@example.test"), orcid: "0000-0002-1825-0098" }],
    });
    const failure = await container.start().then(
      () => null,
      (error: Error) => error,
    );
    expect(failure).not.toBeNull();
    expect(failure?.message).toContain("did not start");
    expect(failure?.message).toContain("check character");
  });

  test("a users file that does not exist fails start naming the path", async () => {
    const failure = await new OrcidMockContainer()
      .withUsers("/no/such/users.json")
      .start()
      .then(
        () => null,
        (error: Error) => error,
      );
    expect(failure?.message).toContain("/no/such/users.json");
  });

  test("withImage replaces the image, and a missing image fails start with its name", async () => {
    const failure = await new OrcidMockContainer()
      .withImage("orcid-mock-does-not-exist:0")
      .start()
      .then(
        () => null,
        (error: Error) => error,
      );
    expect(failure?.message).toContain("orcid-mock-does-not-exist:0");
  });

  test("two containers at once get different ports and each knows its own address", async () => {
    const other = await new OrcidMockContainer().start();
    try {
      expect(other.baseUrl).not.toBe(mock.baseUrl);
      await other.client.createUser(newUser("Second", "second@example.test"));
      expect((await other.client.users()).length).toBe(4);
      expect((await mock.client.users()).length).toBe(3);
    } finally {
      await other.stop();
    }
  });
});

describe("OrcidMockClient against a container", () => {
  test("reset undoes creates, deletes, replaced users, and client changes", async () => {
    const { client } = mock;
    const before = await client.users();
    await client.createUser(newUser("Extra", "extra@example.test"));
    const first = before[0];
    if (!first) throw new Error("the starter has users");
    await client.deleteUser(first.orcid);
    await client.putClient("APP-RESET", {
      client_secret: "s",
      redirect_uris: ["http://localhost:4000/cb"],
    });
    expect(await client.health()).toEqual({ status: "ok", users: 3, clients: 3 });

    expect(await client.reset()).toEqual({ status: "ok", users: 3, clients: 2 });
    expect(await client.users()).toEqual(before);
  });

  test("createUser mints an iD, reads it back, and refuses a duplicate", async () => {
    const { client } = mock;
    const created = await client.createUser(newUser("Minted", "minted@example.test"));
    expect(created.orcid).toMatch(/^0009-9\d{3}-\d{4}-\d{3}[\dX]$/);
    expect(await client.user(created.orcid)).toEqual(created);

    const duplicate = await client
      .createUser({ ...newUser("Again", "again@example.test"), orcid: created.orcid })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(duplicate).toBeInstanceOf(OrcidMockError);
    expect((duplicate as OrcidMockError).status).toBe(409);
  });

  test("putUser creates then replaces, and the path iD wins", async () => {
    const { client } = mock;
    const orcid = "0000-0002-1694-233X";
    const created = await client.putUser(orcid, newUser("First", "put@example.test"));
    expect(created.orcid).toBe(orcid);
    const replaced = await client.putUser(orcid, newUser("Second", "put@example.test"));
    expect(replaced.name.given_names).toBe("Second");
    expect((await client.users()).filter((user) => user.orcid === orcid)).toHaveLength(1);
  });

  test("deleteUser removes the user, and an unknown iD is a 404 error", async () => {
    const { client } = mock;
    const created = await client.createUser(newUser("Gone", "gone@example.test"));
    await client.deleteUser(created.orcid);
    const lookup = await client.user(created.orcid).then(
      () => null,
      (error: unknown) => error,
    );
    expect((lookup as OrcidMockError).status).toBe(404);
    const again = await client.deleteUser(created.orcid).then(
      () => null,
      (error: unknown) => error,
    );
    expect((again as OrcidMockError).status).toBe(404);
  });

  test("an invalid user is a 400 error carrying the server's issues", async () => {
    const failure = await mock.client
      .createUser({ ...newUser("Bad", "bad@example.test"), orcid: "0000-0002-1825-0098" })
      .then(
        () => null,
        (error: unknown) => error as OrcidMockError,
      );
    expect(failure?.status).toBe(400);
    expect(failure?.body).toContain("invalid_fixture");
    expect(failure?.body).toContain("orcid");
  });

  test("advanceClock returns the total offset, and reset zeroes it", async () => {
    const { client } = mock;
    expect(await client.advanceClock(5)).toBe(5_000);
    expect(await client.advanceClock(2)).toBe(7_000);
    await client.reset();
    expect(await client.advanceClock(1)).toBe(1_000);
  });

  test("signIn runs the headless sequence and returns the token response", async () => {
    const { client } = mock;
    const [alder] = await client.users();
    if (!alder) throw new Error("the starter has users");
    const token = await client.signIn({ orcid: alder.orcid });
    expect(token.orcid).toBe(alder.orcid);
    expect(token.token_type).toBe("bearer");
    expect(token.scope).toBe("/authenticate");
    expect(token.access_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(token.name).toBe("A. Fennimore");
  });

  test("signIn with a registered client, a scope, and a nonce", async () => {
    const { client } = mock;
    const [alder] = await client.users();
    if (!alder) throw new Error("the starter has users");
    await client.putClient("APP-OWN", {
      client_secret: "own-secret",
      redirect_uris: ["http://localhost:4100/callback"],
    });
    const token = await client.signIn({
      orcid: alder.orcid,
      clientId: "APP-OWN",
      clientSecret: "own-secret",
      redirectUri: "http://localhost:4100/callback",
      scope: "openid",
      nonce: "n-0S6_WzA2Mj",
    });
    expect(token.orcid).toBe(alder.orcid);
    expect(token.scope).toBe("openid");
  });

  test("signIn as a locked user, or with a wrong secret, is an error, not a token", async () => {
    const { client } = mock;
    const users = await client.users();
    const locked = users.find((user) => user.locked === true);
    const open = users.find((user) => user.locked !== true);
    if (!locked || !open) throw new Error("the starter has a locked user and an open one");

    const refused = await client.signIn({ orcid: locked.orcid }).then(
      () => null,
      (error: unknown) => error as OrcidMockError,
    );
    expect(refused).toBeInstanceOf(OrcidMockError);
    expect(refused?.status).toBe(400);

    const badSecret = await client.signIn({ orcid: open.orcid, clientSecret: "wrong" }).then(
      () => null,
      (error: unknown) => error as OrcidMockError,
    );
    expect(badSecret).toBeInstanceOf(OrcidMockError);
    expect(badSecret?.message).toContain("/oauth/token");
  });

  test("signIn with an unregistered redirect URI is an error naming the answer", async () => {
    const { client } = mock;
    const [alder] = await client.users();
    if (!alder) throw new Error("the starter has users");
    const failure = await client
      .signIn({ orcid: alder.orcid, redirectUri: "http://localhost:9/elsewhere" })
      .then(
        () => null,
        (error: unknown) => error as OrcidMockError,
      );
    expect(failure?.status).toBe(400);
    expect(failure?.message).toContain("/oauth/authorize");
  });

  test("a scope the client may not have is reported as the error redirect it is", async () => {
    const { client } = mock;
    const [alder] = await client.users();
    if (!alder) throw new Error("the starter has users");
    const failure = await client.signIn({ orcid: alder.orcid, scope: "/read-limited" }).then(
      () => null,
      (error: unknown) => error as OrcidMockError,
    );
    // The public starter client may not ask for /read-limited: the mock redirects with
    // #error=invalid_scope, which has no code.
    expect(failure?.message).toContain("invalid_scope");
  });
});
