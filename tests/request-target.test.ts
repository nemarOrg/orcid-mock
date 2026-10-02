// `requestTarget` is a pure function over a URL's text, so it is called directly with real URLs.
// The cases an HTTP request cannot reach (Bun leaves `Request.url` relative when `Host` does not
// parse, and then the router answers 404 before any handler runs) are covered here.
import { describe, expect, test } from "bun:test";
import { requestTarget } from "../src/request-target";

describe("requestTarget", () => {
  test("splits an absolute URL into its raw path and query", () => {
    expect(requestTarget("http://localhost:9700/oauth/authorize?a=1&b=%7E#frag")).toEqual({
      path: "/oauth/authorize",
      search: "a=1&b=%7E",
    });
  });

  test("keeps escapes in the path as sent", () => {
    expect(requestTarget("http://h/v3.0/x/employment/%31%30?q=%zz").path).toBe(
      "/v3.0/x/employment/%31%30",
    );
  });

  test("an authority that URL parsing would reject does not matter", () => {
    for (const authority of ["[::1", "a:b:c", "%zz", "evil.example:99999"]) {
      expect(requestTarget(`http://${authority}/p/q?x=1`)).toEqual({ path: "/p/q", search: "x=1" });
    }
  });

  test("a relative URL is the request target itself, even with :// in the query", () => {
    expect(requestTarget("/p/q?redirect_uri=http://x/y")).toEqual({
      path: "/p/q",
      search: "redirect_uri=http://x/y",
    });
  });

  test("no query is an empty search, and an empty path is /", () => {
    expect(requestTarget("http://h/p")).toEqual({ path: "/p", search: "" });
    expect(requestTarget("http://h")).toEqual({ path: "/", search: "" });
    expect(requestTarget("http://h?x=1")).toEqual({ path: "/", search: "x=1" });
  });

  test("only the first ? starts the query, and a # ends the URL", () => {
    expect(requestTarget("http://h/p?a=?b#c?d")).toEqual({ path: "/p", search: "a=?b" });
  });
});
