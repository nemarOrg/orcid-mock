// The two JSON styles the record API and its error bodies are written in: compact for
// `Accept: application/json`, and a Jackson-default pretty form for `application/orcid+json` and
// `application/vnd.orcid+json` (observed on pub.orcid.org/v3.0 on 2026-10-01).

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/**
 * `JSON.stringify` writes a control character as `\u001f`; Jackson writes the hex digits in
 * capitals (`\u001F`), so the digits are uppercased. The pattern walks escape sequences left to
 * right, so the `\\` of an escaped backslash is consumed with its pair and a literal `u001f`
 * after it is left alone.
 * https://github.com/FasterXML/jackson-core/blob/13b67c80342b3292fb5dc5cd340b6fafa2b37db0/src/main/java/com/fasterxml/jackson/core/io/CharTypes.java#L7-L8
 */
function jacksonEscapes(json: string): string {
  return json.replace(/\\(?:u00([0-9a-f]{2})|[\s\S])/g, (sequence, hex?: string) =>
    hex === undefined ? sequence : `\\u00${hex.toUpperCase()}`,
  );
}

/** Compact JSON: no whitespace and no trailing newline. */
export function compactJson(value: Json): string {
  return jacksonEscapes(JSON.stringify(value));
}

/**
 * Jackson's `DefaultPrettyPrinter` layout, byte for byte as ORCID sends it: an object puts each
 * entry on its own line, indented by two spaces per level, with `" : "` between key and value;
 * an array stays on the line of its key, with `[ ` and ` ]` around its elements and `, ` between
 * them, so an array of objects reads `[ {` ... `}, {` ... `} ]`, and an empty array is `[ ]`
 * (an empty object is `{ }`). Lines end in `\n` and the text has no trailing newline.
 * Arrays do not add an indentation level, because Jackson's array indenter is the inline
 * `FixedSpaceIndenter`:
 * https://github.com/FasterXML/jackson-core/blob/13b67c80342b3292fb5dc5cd340b6fafa2b37db0/src/main/java/com/fasterxml/jackson/core/util/DefaultPrettyPrinter.java#L390-L491
 * The layout was checked against a populated container, `other-names` of a record with three
 * names, `Accept: application/vnd.orcid+json`, observed on pub.orcid.org on 2026-10-01.
 */
export function prettyJson(value: Json): string {
  let out = "";
  const write = (node: Json, depth: number): void => {
    if (node === null || typeof node !== "object") {
      out += JSON.stringify(node);
      return;
    }
    if (Array.isArray(node)) {
      if (node.length === 0) {
        out += "[ ]";
        return;
      }
      out += "[ ";
      node.forEach((element, index) => {
        if (index > 0) out += ", ";
        write(element, depth);
      });
      out += " ]";
      return;
    }
    const entries = Object.entries(node);
    if (entries.length === 0) {
      out += "{ }";
      return;
    }
    const indent = "  ".repeat(depth + 1);
    out += "{\n";
    entries.forEach(([key, entry], index) => {
      if (index > 0) out += ",\n";
      out += `${indent}${JSON.stringify(key)} : `;
      write(entry, depth + 1);
    });
    out += `\n${"  ".repeat(depth)}}`;
  };
  write(value, 0);
  return jacksonEscapes(out);
}
