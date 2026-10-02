// Pure string functions with no I/O, tested directly with real inputs; the same rules are
// exercised end to end through GET /oauth/authorize in oauth-authorize.test.ts.
import { describe, expect, test } from "bun:test";
import { redirectUriMatches, withFragment, withQuery } from "../src/oauth/redirect-uri";

const REGISTERED = ["http://localhost:3000/callback"];
const matches = (requested: string, registered: readonly string[] = REGISTERED) =>
  redirectUriMatches(requested, registered);

describe("redirectUriMatches", () => {
  test("accepts the registered URI and a longer path under it", () => {
    expect(matches("http://localhost:3000/callback")).toBe(true);
    expect(matches("http://localhost:3000/callback/sub")).toBe(true);
    expect(matches("http://localhost:3000/callback/a/b/c")).toBe(true);
  });

  test("rejects a shorter path, another path, and a different origin", () => {
    expect(matches("http://localhost:3000/call")).toBe(false);
    expect(matches("http://localhost:3000/")).toBe(false);
    expect(matches("http://localhost:3000")).toBe(false);
    expect(matches("http://localhost:3000/other")).toBe(false);
    expect(matches("http://localhost:3001/callback")).toBe(false);
    expect(matches("https://localhost:3000/callback")).toBe(false);
    expect(matches("http://localhost.evil.test:3000/callback")).toBe(false);
    expect(matches("http://localhost/callback")).toBe(false);
  });

  test("compares the host case-sensitively and the scheme case-insensitively", () => {
    expect(matches("http://LOCALHOST:3000/callback")).toBe(false);
    expect(matches("HTTP://localhost:3000/callback")).toBe(true);
    expect(matches("http://localhost:3000/callback", ["http://LOCALHOST:3000/callback"])).toBe(
      false,
    );
  });

  test("a plain prefix test: /callbackx passes, as it does at ORCID", () => {
    expect(matches("http://localhost:3000/callbackx")).toBe(true);
  });

  test("compares userinfo and a port as written", () => {
    expect(matches("http://user@localhost:3000/callback")).toBe(false);
    expect(
      matches("http://user@localhost:3000/callback", ["http://user@localhost:3000/callback"]),
    ).toBe(true);
    expect(matches("https://example.test/cb", ["https://example.test:443/cb"])).toBe(false);
    expect(matches("https://example.test:443/cb", ["https://example.test/cb"])).toBe(false);
    expect(matches("https://example.test/cb", ["https://example.test/cb"])).toBe(true);
  });

  test("ignores the query and fragment of the requested URI", () => {
    expect(matches("http://localhost:3000/callback?x=1&y=2")).toBe(true);
    expect(matches("http://localhost:3000/callback#frag")).toBe(true);
    expect(matches("http://localhost:3000/callback?x=1#frag")).toBe(true);
    expect(matches("http://localhost:3000/?next=/callback")).toBe(false);
  });

  test("a host-only registration allows any path", () => {
    expect(matches("https://app.example.test/any/path?q=1", ["https://app.example.test"])).toBe(
      true,
    );
    expect(matches("https://app.example.test", ["https://app.example.test"])).toBe(true);
    expect(matches("https://other.example.test/", ["https://app.example.test"])).toBe(false);
  });

  test("normalizes dot segments before the prefix test", () => {
    expect(matches("http://localhost:3000/callback/../other")).toBe(false);
    expect(matches("http://localhost:3000/callback/./sub")).toBe(true);
    expect(matches("http://localhost:3000/other/../callback")).toBe(true);
    expect(matches("http://localhost:3000/callback/%2e%2e/other")).toBe(false);
    expect(matches("http://localhost:3000/callback/%2E./other")).toBe(false);
    expect(matches("http://localhost:3000/callback/sub/../../other")).toBe(false);
    expect(matches("http://localhost:3000/callback\\..\\other")).toBe(false);
    expect(matches("http://localhost:3000/../callback")).toBe(true);
    expect(matches("http://localhost:3000/", ["http://localhost:3000/"])).toBe(true);
    expect(matches("http://localhost:3000/a/..", ["http://localhost:3000/"])).toBe(true);
  });

  test("any one of several registered URIs is enough", () => {
    const both = ["http://localhost:3000/callback", "https://app.example.test/auth"];
    expect(matches("https://app.example.test/auth/done", both)).toBe(true);
    expect(matches("https://app.example.test/callback", both)).toBe(false);
    expect(matches("https://app.example.test/auth", [])).toBe(false);
  });

  test("rejects what is not an absolute URI with a host", () => {
    for (const bad of [
      "",
      "/callback",
      "localhost:3000/callback",
      "http:///callback",
      "http://",
      "javascript:alert(1)",
      "http//localhost:3000/callback",
    ]) {
      expect(matches(bad)).toBe(false);
    }
  });

  test("rejects a URI that could not be a header value", () => {
    for (const bad of [
      "http://localhost:3000/callback x",
      "http://localhost:3000/callback\r\nSet-Cookie: a=b",
      "http://localhost:3000/callback\n",
      "http://localhost:3000/callback/é",
      "http://localhost:3000/callback/\u0000",
    ]) {
      expect(matches(bad)).toBe(false);
    }
    expect(matches("http://localhost:3000/callback/%C3%A9")).toBe(true);
  });
});

describe("withQuery", () => {
  test("adds ? to a URI with no query and & to one that has a query", () => {
    expect(withQuery("http://localhost:3000/cb", [["code", "abc123"]])).toBe(
      "http://localhost:3000/cb?code=abc123",
    );
    expect(withQuery("http://localhost:3000/cb?next=%2Fhome", [["code", "abc123"]])).toBe(
      "http://localhost:3000/cb?next=%2Fhome&code=abc123",
    );
    expect(withQuery("http://localhost:3000/cb?", [["code", "abc123"]])).toBe(
      "http://localhost:3000/cb?code=abc123",
    );
    expect(withQuery("http://localhost:3000/cb?a=1&", [["code", "abc123"]])).toBe(
      "http://localhost:3000/cb?a=1&code=abc123",
    );
  });

  test("percent-encodes values once and keeps a fragment at the end", () => {
    expect(
      withQuery("http://localhost:3000/cb#frag", [
        ["code", "abc123"],
        ["state", "a&b=c d+é"],
      ]),
    ).toBe("http://localhost:3000/cb?code=abc123&state=a%26b%3Dc%20d%2B%C3%A9#frag");
  });
});

describe("withFragment", () => {
  test("sets the fragment, replacing an existing one", () => {
    expect(withFragment("http://localhost:3000/cb", "error=invalid_scope")).toBe(
      "http://localhost:3000/cb#error=invalid_scope",
    );
    expect(withFragment("http://localhost:3000/cb?x=1#old", "login_required")).toBe(
      "http://localhost:3000/cb?x=1#login_required",
    );
  });
});
