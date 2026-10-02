// The conformance suite's own support code, which has no HTTP surface: the target loader and the
// structural checker. Both are tested directly, with real inputs, so a loader that quietly
// accepted a bad variable or a checker that passed a reordered body would fail here and not
// silently weaken the suite.
import { describe, expect, test } from "bun:test";
import { check, recordShapes } from "../conformance/shapes";
import { loadTarget } from "../conformance/target";

const COMPLETE = {
  CONFORMANCE_TARGET: "sandbox",
  ORCID_API_BASE: "https://sandbox.orcid.org/",
  ORCID_PUB_API_BASE: "https://pub.sandbox.orcid.org",
  ORCID_CLIENT_ID: "APP-EXAMPLE0000000000",
  ORCID_CLIENT_SECRET: "a-secret-value-that-must-not-appear",
  ORCID_PUBLIC_ID: "0000-0002-1825-0097",
};

describe("loadTarget", () => {
  test("reads a complete environment", () => {
    const target = loadTarget(COMPLETE);
    expect(target.name).toBe("sandbox");
    expect(target.apiBase).toBe("https://sandbox.orcid.org");
    expect(target.pubApiBase).toBe("https://pub.sandbox.orcid.org");
    expect(target.clientId).toBe("APP-EXAMPLE0000000000");
    expect(target.publicId).toBe("0000-0002-1825-0097");
  });

  test("spaces the sandbox's requests and not the mock's", () => {
    expect(loadTarget(COMPLETE).requestDelayMs).toBeGreaterThan(0);
    expect(loadTarget({ ...COMPLETE, CONFORMANCE_TARGET: "mock" }).requestDelayMs).toBe(0);
  });

  test("names every missing variable in one message and prints no value", () => {
    const { ORCID_CLIENT_ID: _id, ORCID_CLIENT_SECRET: _secret, ...rest } = COMPLETE;
    const failure = (): Error => {
      try {
        loadTarget({ ...rest, ORCID_PUBLIC_ID: "   " });
      } catch (error) {
        return error as Error;
      }
      throw new Error("loadTarget accepted an incomplete environment");
    };
    const message = failure().message;
    for (const name of ["ORCID_CLIENT_ID", "ORCID_CLIENT_SECRET", "ORCID_PUBLIC_ID"]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("sandbox.orcid.org");
  });

  test("never echoes a credential, whatever else is wrong", () => {
    for (const bad of [
      { ...COMPLETE, CONFORMANCE_TARGET: "prod" },
      { ...COMPLETE, ORCID_API_BASE: "not a url" },
      { ...COMPLETE, ORCID_PUB_API_BASE: "ftp://pub.example.test" },
      { ...COMPLETE, ORCID_PUBLIC_ID: "0000-0002-1825" },
    ]) {
      expect(() => loadTarget(bad)).toThrow();
      try {
        loadTarget(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain(COMPLETE.ORCID_CLIENT_SECRET);
      }
    }
  });
});

describe("check", () => {
  const shape = {
    keys: {
      id: "number",
      name: { either: ["null", { keys: { value: "string" } }] },
      tags: { list: "string" },
      path: { is: "/x" },
      kind: { matches: /^work-\d+$/ },
      free: "any",
    },
  } as const;
  const good = { id: 1, name: { value: "a" }, tags: ["x"], path: "/x", kind: "work-7", free: {} };

  test("passes a body with the right keys in the right order and kinds", () => {
    expect(check(good, shape)).toEqual([]);
    expect(check({ ...good, name: null, tags: [] }, shape)).toEqual([]);
  });

  test("fails a reordered body and says where", () => {
    const { id, name, ...rest } = good;
    const reordered = { name, id, ...rest };
    expect(check(reordered, shape)).toEqual([
      "$: keys [name, id, tags, path, kind, free] but expected [id, name, tags, path, kind, free]",
    ]);
  });

  test("fails a missing key, an extra key, and a wrong kind", () => {
    const { tags: _tags, ...missing } = good;
    expect(check(missing, shape)[0]).toContain("keys [id, name, path, kind, free]");
    expect(check({ ...good, extra: 1 }, shape)[0]).toContain("extra");
    expect(check({ ...good, id: "1" }, shape)).toEqual(["$.id: expected number, got string"]);
    expect(check({ ...good, id: Number.NaN }, shape)).toEqual([
      "$.id: expected number, got number",
    ]);
    expect(check({ ...good, tags: ["x", 2] }, shape)).toEqual([
      "$.tags[1]: expected string, got number",
    ]);
    expect(check({ ...good, name: { value: 1 } }, shape)).toEqual([
      "$.name.value: expected string, got number",
    ]);
  });

  test("fails a path that is not the expected one and a kind that does not match", () => {
    expect(check({ ...good, path: "/y" }, shape)).toEqual(['$.path: expected "/x"']);
    expect(check({ ...good, kind: "work-x" }, shape)[0]).toContain("$.kind: expected a string");
  });

  test("tells an array and null from an object", () => {
    expect(check([], shape)).toEqual(["$: expected object, got array"]);
    expect(check(null, shape)).toEqual(["$: expected object, got null"]);
  });
});

describe("recordShapes", () => {
  test("hold a nearly empty record, the shape of a new account", () => {
    const iD = "0000-0001-6919-3953";
    const shapes = recordShapes(iD);
    const emptyContainer = (members: string, section: string) => ({
      "last-modified-date": null,
      [members]: [],
      path: `/${iD}/${section}`,
    });
    const works = emptyContainer("group", "works");
    expect(check(works, shapes.works)).toEqual([]);
    expect(check(emptyContainer("email", "email"), shapes.email)).toEqual([]);
    expect(check({ ...works, path: "/elsewhere/works" }, shapes.works)).toHaveLength(1);
  });
});
