// The printer is a pure function with no I/O, so it is tested directly with real inputs; the same
// bytes are checked over HTTP in the record API tests once the routes exist.
import { describe, expect, test } from "bun:test";
import { compactJson, prettyJson } from "../src/json";

describe("prettyJson", () => {
  test("an empty email container is the 91 bytes ORCID sends, with no trailing newline", () => {
    const body = {
      "last-modified-date": null,
      email: [],
      path: "/0000-0002-1825-0097/email",
    };
    const text = prettyJson(body);
    expect(text).toBe(
      [
        "{",
        '  "last-modified-date" : null,',
        '  "email" : [ ],',
        '  "path" : "/0000-0002-1825-0097/email"',
        "}",
      ].join("\n"),
    );
    expect(new TextEncoder().encode(text).length).toBe(91);
    expect(new TextEncoder().encode(compactJson(body)).length).toBe(74);
  });

  test("an array of objects stays on its key's line and adds no indentation level", () => {
    const text = prettyJson({
      "last-modified-date": { value: 1462157547720 },
      "other-name": [
        { content: "first", "display-index": 3 },
        { content: "second", "display-index": 2 },
      ],
      path: "/x/other-names",
    });
    expect(text).toBe(
      [
        "{",
        '  "last-modified-date" : {',
        '    "value" : 1462157547720',
        "  },",
        '  "other-name" : [ {',
        '    "content" : "first",',
        '    "display-index" : 3',
        "  }, {",
        '    "content" : "second",',
        '    "display-index" : 2',
        "  } ],",
        '  "path" : "/x/other-names"',
        "}",
      ].join("\n"),
    );
  });

  test("scalars in arrays, empty objects, and nested arrays follow Jackson's inline rules", () => {
    expect(prettyJson({ a: [1, "two", null, true], b: {}, c: [[1], []] })).toBe(
      [
        "{",
        '  "a" : [ 1, "two", null, true ],',
        '  "b" : { },',
        '  "c" : [ [ 1 ], [ ] ]',
        "}",
      ].join("\n"),
    );
  });

  test("a bare scalar or array at the root has no layout to add", () => {
    expect(prettyJson(null)).toBe("null");
    expect(prettyJson("a\r\nb")).toBe('"a\\r\\nb"');
    expect(prettyJson([])).toBe("[ ]");
  });

  test("a control character is escaped with capital hex digits, as Jackson writes it", () => {
    const value = { note: "tab\t, unit separator \u001f, vertical tab \u000b" };
    expect(compactJson(value)).toBe(
      '{"note":"tab\\t, unit separator \\u001F, vertical tab \\u000B"}',
    );
    expect(prettyJson(value)).toContain(
      '"note" : "tab\\t, unit separator \\u001F, vertical tab \\u000B"',
    );
    // A backslash followed by the text u001f is not an escape and is left alone.
    const literal = { note: "\\u001f" };
    expect(compactJson(literal)).toBe('{"note":"\\\\u001f"}');
    expect(JSON.parse(compactJson(value))).toEqual(value);
    expect(JSON.parse(compactJson(literal))).toEqual(literal);
  });

  test("the pretty and compact forms parse to the same value", () => {
    const value = {
      note: 'quote " and \\ and é and ☃',
      list: [{ k: [] }, { k: [{ n: 1.5 }] }],
    };
    expect(JSON.parse(prettyJson(value))).toEqual(value);
    expect(JSON.parse(compactJson(value))).toEqual(value);
  });
});
