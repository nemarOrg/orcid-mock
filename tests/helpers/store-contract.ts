// A reusable contract suite for any Store implementation: real values in, real values out, no
// stand-ins. MemoryStore runs it in tests/store.test.ts; the MVP2 Durable Object store runs the
// same suite by passing its own factory.
import { describe, expect, test } from "bun:test";
import { parseUsersFile } from "../../src/fixtures/load";
import { STARTER_USERS_FILE } from "../../src/fixtures/starter";
import {
  type AuthCode,
  ClockRangeError,
  type Session,
  type SigningKey,
  type Snapshot,
  type Store,
  type StoredClient,
  type StoredUser,
  type TokenRecord,
} from "../../src/store/types";

function starterSnapshot(): Snapshot {
  const result = parseUsersFile(STARTER_USERS_FILE, 1_000);
  if (!result.ok) throw new Error("the starter fixture must load");
  return result.snapshot;
}

function code(value: string, over: Partial<AuthCode> = {}): AuthCode {
  return {
    code: value,
    client_id: "APP-ORCIDMOCK000001",
    orcid: "0000-0002-1825-0097",
    scopes: ["/authenticate", "openid"],
    redirect_uri: "http://localhost:3000/callback",
    nonce: "n-0S6_WzA2Mj",
    auth_time_ms: 1_000,
    amr: null,
    expires_at_ms: 601_000,
    ...over,
  };
}

function token(access: string, refresh: string, over: Partial<TokenRecord> = {}): TokenRecord {
  return {
    access_token: access,
    refresh_token: refresh,
    client_id: "APP-ORCIDMOCK000001",
    orcid: "0000-0002-1825-0097",
    scopes: ["/authenticate"],
    member: false,
    issued_at_ms: 1_000,
    expires_at_ms: 631_139_518_000,
    revoked: false,
    auth_time_ms: 1_000,
    nonce: null,
    ...over,
  };
}

function session(id: string): Session {
  return { id, orcid: "0000-0002-1825-0097", auth_time_ms: 1_000, expires_at_ms: 3_601_000 };
}

function key(kid: string): SigningKey {
  return {
    kid,
    private_jwk: { kty: "RSA", n: `private-${kid}`, e: "AQAB", d: "secret" },
    public_jwk: { kty: "RSA", n: `public-${kid}`, e: "AQAB" },
    created_ms: 1_000,
  };
}

function client(id: string, over: Partial<StoredClient> = {}): StoredClient {
  return {
    client_id: id,
    client_secret: "secret",
    name: id,
    redirect_uris: ["http://localhost:3000/callback"],
    member: false,
    ...over,
  };
}

export function runStoreContract(name: string, makeStore: () => Store | Promise<Store>): void {
  describe(`Store contract: ${name}`, () => {
    const fresh = async (): Promise<Store> => {
      const store = await makeStore();
      await store.setBaseline(starterSnapshot());
      return store;
    };
    const firstUser = async (store: Store): Promise<StoredUser> => {
      const [user] = await store.listUsers();
      if (!user) throw new Error("the baseline has users");
      return user;
    };

    describe("users", () => {
      test("setBaseline applies the snapshot, in order", async () => {
        const store = await fresh();
        const snapshot = starterSnapshot();
        expect((await store.listUsers()).map((user) => user.orcid)).toEqual(
          snapshot.users.map((user) => user.orcid),
        );
        expect(await store.listUsers()).toEqual(snapshot.users);
        expect(await store.listClients()).toEqual(snapshot.clients);
      });

      test("getUser finds a user and answers null for an unknown iD", async () => {
        const store = await fresh();
        const user = await firstUser(store);
        expect(await store.getUser(user.orcid)).toEqual(user);
        expect(await store.getUser("0000-0002-1825-0097")).toBeNull();
      });

      test("insertUser creates, then conflicts without changing the stored user", async () => {
        const store = await fresh();
        const original = await firstUser(store);
        expect(await store.insertUser({ ...original, password: "changed" })).toBe("conflict");
        expect(await store.getUser(original.orcid)).toEqual(original);

        const created = { ...original, orcid: "0000-0002-1825-0097" };
        expect(await store.insertUser(created)).toBe("created");
        expect(await store.getUser("0000-0002-1825-0097")).toEqual(created);
        expect(await store.insertUser(created)).toBe("conflict");
      });

      test("upsertUser creates, then replaces in place", async () => {
        const store = await fresh();
        const before = await store.listUsers();
        const original = before[0] as StoredUser;
        const replacement = { ...original, password: "replaced" };
        expect(await store.upsertUser(replacement)).toBe("replaced");
        const after = await store.listUsers();
        expect(after.map((user) => user.orcid)).toEqual(before.map((user) => user.orcid));
        expect(after[0]?.password).toBe("replaced");

        const added = { ...original, orcid: "0000-0002-1825-0097" };
        expect(await store.upsertUser(added)).toBe("created");
        expect((await store.listUsers()).at(-1)?.orcid).toBe("0000-0002-1825-0097");
      });

      test("deleteUser reports whether there was a user", async () => {
        const store = await fresh();
        const user = await firstUser(store);
        expect(await store.deleteUser(user.orcid)).toBe(true);
        expect(await store.getUser(user.orcid)).toBeNull();
        expect(await store.deleteUser(user.orcid)).toBe(false);
      });

      test("mutating a passed-in or returned user does not change stored state", async () => {
        const store = await fresh();
        const original = await firstUser(store);
        const passedIn = structuredClone(original);
        passedIn.orcid = "0000-0002-1825-0097";
        await store.insertUser(passedIn);
        passedIn.name.given_names = "MUTATED AFTER INSERT";

        const stored = await store.getUser("0000-0002-1825-0097");
        expect(stored?.name.given_names).toBe(original.name.given_names);
        if (!stored) throw new Error("the inserted user exists");
        stored.name.given_names = "MUTATED AFTER GET";
        stored.keywords?.push({
          put_code: 1,
          content: "x",
          visibility: "public",
          created_ms: 1,
          modified_ms: 1,
        });

        expect((await store.getUser("0000-0002-1825-0097"))?.name.given_names).toBe(
          original.name.given_names,
        );
        const listed = await store.listUsers();
        (listed[0] as StoredUser).name.given_names = "MUTATED AFTER LIST";
        expect((await firstUser(store)).name.given_names).toBe(original.name.given_names);
      });
    });

    describe("clients", () => {
      test("getClient, listClients, and upsertClient", async () => {
        const store = await fresh();
        expect((await store.listClients()).map((c) => c.client_id)).toEqual([
          "APP-ORCIDMOCK000001",
          "APP-ORCIDMOCK000002",
        ]);
        expect(await store.getClient("APP-NOPE")).toBeNull();
        expect(await store.upsertClient(client("APP-NEW"))).toBe("created");
        expect(await store.upsertClient(client("APP-NEW", { member: true }))).toBe("replaced");
        expect((await store.getClient("APP-NEW"))?.member).toBe(true);
        expect(await store.listClients()).toHaveLength(3);
      });

      test("clones in and out", async () => {
        const store = await fresh();
        const passedIn = client("APP-CLONE");
        await store.upsertClient(passedIn);
        passedIn.redirect_uris.push("http://evil.example.test/cb");
        const stored = await store.getClient("APP-CLONE");
        expect(stored?.redirect_uris).toEqual(["http://localhost:3000/callback"]);
        stored?.redirect_uris.push("http://evil.example.test/cb");
        expect((await store.getClient("APP-CLONE"))?.redirect_uris).toHaveLength(1);
      });
    });

    describe("authorization codes", () => {
      test("consumeCode takes and deletes: a second call gets null", async () => {
        const store = await fresh();
        const original = code("aB3xY9");
        await store.putCode(original);
        expect(await store.consumeCode("aB3xY9")).toEqual(original);
        expect(await store.consumeCode("aB3xY9")).toBeNull();
      });

      test("an unknown code is null", async () => {
        expect(await (await fresh()).consumeCode("nope00")).toBeNull();
      });

      test("concurrent consumes give the code to exactly one caller", async () => {
        const store = await fresh();
        await store.putCode(code("r4c3zz"));
        const results = await Promise.all(
          Array.from({ length: 5 }, () => store.consumeCode("r4c3zz")),
        );
        expect(results.filter((result) => result !== null)).toHaveLength(1);
      });

      test("an expired code is still returned: expiry is the caller's check", async () => {
        const store = await fresh();
        await store.putCode(code("old000", { expires_at_ms: 1 }));
        expect((await store.consumeCode("old000"))?.expires_at_ms).toBe(1);
      });

      test("clones in and out", async () => {
        const store = await fresh();
        const passedIn = code("cl0n3d");
        await store.putCode(passedIn);
        passedIn.scopes.push("/read-limited");
        const taken = await store.consumeCode("cl0n3d");
        expect(taken?.scopes).toEqual(["/authenticate", "openid"]);
      });
    });

    describe("tokens", () => {
      test("putTokens is readable by access token and by refresh token", async () => {
        const store = await fresh();
        const original = token("a1", "r1");
        await store.putTokens(original);
        expect(await store.getAccessToken("a1")).toEqual(original);
        expect(await store.getRefreshToken("r1")).toEqual(original);
        expect(await store.getAccessToken("r1")).toBeNull();
        expect(await store.getRefreshToken("a1")).toBeNull();
        expect(await store.getAccessToken("nope")).toBeNull();
      });

      test("a client-credentials token has no iD", async () => {
        const store = await fresh();
        await store.putTokens(token("cc", "ccr", { orcid: null, auth_time_ms: null }));
        expect((await store.getAccessToken("cc"))?.orcid).toBeNull();
      });

      test("rotateRefresh with revokeOld true revokes the old pair and stores the new", async () => {
        const store = await fresh();
        await store.putTokens(token("a1", "r1"));
        const next = token("a2", "r2");
        expect(await store.rotateRefresh("r1", next, true)).toEqual(next);
        expect((await store.getAccessToken("a1"))?.revoked).toBe(true);
        expect((await store.getRefreshToken("r1"))?.revoked).toBe(true);
        expect(await store.getAccessToken("a2")).toEqual(next);
        expect(await store.getRefreshToken("r2")).toEqual(next);
      });

      test("rotateRefresh with revokeOld false leaves the old pair valid", async () => {
        const store = await fresh();
        await store.putTokens(token("a1", "r1"));
        expect(await store.rotateRefresh("r1", token("a2", "r2"), false)).not.toBeNull();
        expect((await store.getAccessToken("a1"))?.revoked).toBe(false);
        // The old refresh token can be used again.
        expect(await store.rotateRefresh("r1", token("a3", "r3"), false)).not.toBeNull();
      });

      test("rotateRefresh on an unknown or a revoked token is null and stores nothing", async () => {
        const store = await fresh();
        expect(await store.rotateRefresh("unknown", token("a9", "r9"), true)).toBeNull();
        expect(await store.getAccessToken("a9")).toBeNull();

        await store.putTokens(token("a1", "r1"));
        await store.rotateRefresh("r1", token("a2", "r2"), true);
        expect(await store.rotateRefresh("r1", token("a3", "r3"), true)).toBeNull();
        expect(await store.getAccessToken("a3")).toBeNull();
        expect(await store.getRefreshToken("r3")).toBeNull();
      });

      test("concurrent rotations of one refresh token: exactly one wins when it revokes", async () => {
        const store = await fresh();
        await store.putTokens(token("a1", "r1"));
        const results = await Promise.all(
          ["b", "c", "d"].map((id) => store.rotateRefresh("r1", token(`a-${id}`, `r-${id}`), true)),
        );
        expect(results.filter((result) => result !== null)).toHaveLength(1);
      });

      test("revoke by access token revokes the pair", async () => {
        const store = await fresh();
        await store.putTokens(token("a1", "r1"));
        expect(await store.revoke("a1")).toBe(true);
        expect((await store.getAccessToken("a1"))?.revoked).toBe(true);
        expect((await store.getRefreshToken("r1"))?.revoked).toBe(true);
      });

      test("revoke by refresh token revokes the pair", async () => {
        const store = await fresh();
        await store.putTokens(token("a1", "r1"));
        expect(await store.revoke("r1")).toBe(true);
        expect((await store.getAccessToken("a1"))?.revoked).toBe(true);
        expect((await store.getRefreshToken("r1"))?.revoked).toBe(true);
      });

      test("revoke of an unknown token is false", async () => {
        expect(await (await fresh()).revoke("nope")).toBe(false);
      });

      test("storing a token under an existing access token drops its old refresh token", async () => {
        const store = await fresh();
        await store.putTokens(token("a1", "r1"));
        await store.putTokens(token("a1", "r2"));
        expect(await store.getRefreshToken("r1")).toBeNull();
        expect((await store.getRefreshToken("r2"))?.access_token).toBe("a1");
      });

      test("clones in and out", async () => {
        const store = await fresh();
        const passedIn = token("a1", "r1");
        await store.putTokens(passedIn);
        passedIn.scopes.push("/read-limited");
        const stored = await store.getAccessToken("a1");
        expect(stored?.scopes).toEqual(["/authenticate"]);
        if (stored) stored.revoked = true;
        expect((await store.getAccessToken("a1"))?.revoked).toBe(false);
      });
    });

    describe("sessions", () => {
      test("put, get, delete", async () => {
        const store = await fresh();
        expect(await store.getSession("s1")).toBeNull();
        await store.putSession(session("s1"));
        expect(await store.getSession("s1")).toEqual(session("s1"));
        await store.deleteSession("s1");
        expect(await store.getSession("s1")).toBeNull();
        await store.deleteSession("s1");
      });
    });

    describe("counters", () => {
      test("start at the baseline and count up one at a time", async () => {
        const store = await fresh();
        const snapshot = starterSnapshot();
        expect(await store.nextPutCode()).toBe(snapshot.next_put_code);
        expect(await store.nextPutCode()).toBe(snapshot.next_put_code + 1);
        expect(await store.nextMintSeq()).toBe(1);
        expect(await store.nextMintSeq()).toBe(2);
      });

      test("concurrent draws never repeat", async () => {
        const store = await fresh();
        const draws = await Promise.all(Array.from({ length: 20 }, () => store.nextPutCode()));
        expect(new Set(draws).size).toBe(20);
      });
    });

    describe("clock", () => {
      test("starts at zero and accumulates, in milliseconds", async () => {
        const store = await fresh();
        expect(await store.clockOffsetMs()).toBe(0);
        expect(await store.advanceClock(90)).toBe(90_000);
        expect(await store.advanceClock(0.5)).toBe(90_500);
        expect(await store.clockOffsetMs()).toBe(90_500);
      });

      test("rejects a negative, NaN, or infinite advance with a ClockRangeError", async () => {
        const store = await fresh();
        for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          await expect(store.advanceClock(bad)).rejects.toBeInstanceOf(ClockRangeError);
        }
        expect(await store.clockOffsetMs()).toBe(0);
      });

      test("rejects an advance that overflows or leaves the Date range, and leaves the offset", async () => {
        const store = await fresh();
        await store.advanceClock(60);
        for (const bad of [1e308, 9e12, Number.MAX_VALUE]) {
          await expect(store.advanceClock(bad)).rejects.toBeInstanceOf(ClockRangeError);
        }
        expect(await store.clockOffsetMs()).toBe(60_000);
        // A century is fine.
        expect(await store.advanceClock(100 * 365 * 86_400)).toBeGreaterThan(60_000);
      });

      test("a ClockRangeError is a RangeError", async () => {
        const store = await fresh();
        await expect(store.advanceClock(-1)).rejects.toBeInstanceOf(RangeError);
      });
    });

    describe("signing key", () => {
      test("none to begin with; the first putSigningKeyIfAbsent stores and returns it", async () => {
        const store = await fresh();
        expect(await store.getSigningKey()).toBeNull();
        expect(await store.putSigningKeyIfAbsent(key("first"))).toEqual(key("first"));
        expect(await store.getSigningKey()).toEqual(key("first"));
      });

      test("a later putSigningKeyIfAbsent returns the stored key and changes nothing", async () => {
        const store = await fresh();
        await store.putSigningKeyIfAbsent(key("first"));
        expect(await store.putSigningKeyIfAbsent(key("second"))).toEqual(key("first"));
        expect((await store.getSigningKey())?.kid).toBe("first");
      });

      test("two concurrent first calls with different keys return the same winner", async () => {
        const store = await fresh();
        const [a, b] = await Promise.all([
          store.putSigningKeyIfAbsent(key("A")),
          store.putSigningKeyIfAbsent(key("B")),
        ]);
        expect(a).toEqual(b);
        expect(await store.getSigningKey()).toEqual(a);
      });

      test("clones in and out", async () => {
        const store = await fresh();
        const passedIn = key("clone");
        const returned = await store.putSigningKeyIfAbsent(passedIn);
        passedIn.kid = "mutated";
        returned.public_jwk.n = "mutated";
        const stored = await store.getSigningKey();
        expect(stored?.kid).toBe("clone");
        expect(stored?.public_jwk.n).toBe("public-clone");
        if (stored) stored.private_jwk.d = "mutated";
        expect((await store.getSigningKey())?.private_jwk.d).toBe("secret");
      });
    });

    describe("reset", () => {
      test("restores users, clients, and counters; clears codes, tokens, sessions, and the clock; keeps the key", async () => {
        const store = await fresh();
        const snapshot = starterSnapshot();
        const users = await store.listUsers();

        await store.deleteUser((users[0] as StoredUser).orcid);
        await store.upsertUser({ ...(users[1] as StoredUser), password: "changed" });
        await store.insertUser({ ...(users[2] as StoredUser), orcid: "0000-0002-1825-0097" });
        await store.upsertClient(client("APP-EXTRA"));
        await store.upsertClient(client("APP-ORCIDMOCK000001", { client_secret: "changed" }));
        await store.putCode(code("aB3xY9"));
        await store.putTokens(token("a1", "r1"));
        await store.putSession(session("s1"));
        await store.nextPutCode();
        await store.nextMintSeq();
        await store.advanceClock(3_600);
        await store.putSigningKeyIfAbsent(key("kept"));

        await store.reset();

        expect(await store.listUsers()).toEqual(snapshot.users);
        expect(await store.listClients()).toEqual(snapshot.clients);
        expect(await store.consumeCode("aB3xY9")).toBeNull();
        expect(await store.getAccessToken("a1")).toBeNull();
        expect(await store.getRefreshToken("r1")).toBeNull();
        expect(await store.getSession("s1")).toBeNull();
        expect(await store.nextPutCode()).toBe(snapshot.next_put_code);
        expect(await store.nextMintSeq()).toBe(snapshot.next_mint_seq);
        expect(await store.clockOffsetMs()).toBe(0);
        expect((await store.getSigningKey())?.kid).toBe("kept");
      });

      test("is repeatable: a mutation after a reset does not leak into the baseline", async () => {
        const store = await fresh();
        const snapshot = starterSnapshot();
        const users = await store.listUsers();
        await store.deleteUser((users[0] as StoredUser).orcid);
        await store.reset();
        (await firstUser(store)).name.given_names = "MUTATED";
        await store.upsertUser({ ...(await firstUser(store)), password: "changed" });
        await store.reset();
        expect(await store.listUsers()).toEqual(snapshot.users);
      });

      test("setBaseline copies the snapshot: mutating it afterwards changes nothing", async () => {
        const store = await makeStore();
        const snapshot = starterSnapshot();
        await store.setBaseline(snapshot);
        snapshot.users.length = 0;
        snapshot.clients.length = 0;
        await store.reset();
        expect(await store.listUsers()).toHaveLength(3);
        expect(await store.listClients()).toHaveLength(2);
      });

      test("a store with no baseline resets to empty", async () => {
        const store = await makeStore();
        await store.upsertUser(starterSnapshot().users[0] as StoredUser);
        await store.reset();
        expect(await store.listUsers()).toEqual([]);
        expect(await store.listClients()).toEqual([]);
      });
    });
  });
}
