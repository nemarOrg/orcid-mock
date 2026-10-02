// getSigningKey takes a Store and has no HTTP surface of its own, so it is tested directly with
// the real MemoryStore and no stand-in, like the Store contract suite. The race is exercised here,
// where every call can be started before any of them finishes generating a key; an HTTP request
// to a server in this process may not overlap with another at all.
import { describe, expect, test } from "bun:test";
import { getSigningKey } from "../src/oidc/keys";
import { MemoryStore } from "../src/store/memory";

describe("getSigningKey", () => {
  test("a new store has no key until the first call generates one", async () => {
    const store = new MemoryStore();
    expect(await store.getSigningKey()).toBeNull();
    const key = await getSigningKey(store);
    expect(await store.getSigningKey()).toEqual(key);
    expect(key.kid).toMatch(/^orcid-mock-[0-9a-z]{32}$/);
  });

  test("a later call returns the stored key unchanged", async () => {
    const store = new MemoryStore();
    const first = await getSigningKey(store);
    expect(await getSigningKey(store)).toEqual(first);
  });

  test("ten concurrent first calls on one store all return the one stored key", async () => {
    const store = new MemoryStore();
    const keys = await Promise.all(Array.from({ length: 10 }, () => getSigningKey(store)));
    expect(new Set(keys.map((key) => key.kid)).size).toBe(1);
    expect(new Set(keys.map((key) => key.public_jwk.n)).size).toBe(1);
    expect(new Set(keys.map((key) => key.private_jwk.d)).size).toBe(1);
    expect(keys[0]).toEqual((await store.getSigningKey()) ?? undefined);
  });

  test("two stores, two tenants, generate two keys", async () => {
    const [a, b] = await Promise.all([
      getSigningKey(new MemoryStore()),
      getSigningKey(new MemoryStore()),
    ]);
    expect(a.kid).not.toBe(b.kid);
    expect(a.public_jwk.n).not.toBe(b.public_jwk.n);
  });

  test("the key survives the store's reset", async () => {
    const store = new MemoryStore();
    const key = await getSigningKey(store);
    await store.reset();
    expect(await getSigningKey(store)).toEqual(key);
  });
});
