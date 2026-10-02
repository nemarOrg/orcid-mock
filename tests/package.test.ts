// What the published package promises: every entry point resolves to a file that `files` ships,
// the binary starts with the shebang that makes `bunx` work, and nothing is shipped that the
// package does not need. Real files and a real dry-run pack; nothing is stubbed.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import pkg from "../package.json";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");

/** The files `bun pm pack --dry-run` would put in the tarball. */
async function packedFiles(): Promise<string[]> {
  const child = Bun.spawn([process.execPath, "pm", "pack", "--dry-run"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`bun pm pack --dry-run exited ${exitCode}\n${stderr}`);
  return [...stdout.matchAll(/^packed\s+\S+\s+(\S+)\s*$/gm)].map((match) => match[1] as string);
}

describe("the npm package", () => {
  test("every export target is shipped", async () => {
    const packed = new Set(await packedFiles());
    for (const [name, target] of Object.entries(pkg.exports)) {
      const file = target.replace(/^\.\//, "");
      expect(await Bun.file(join(ROOT, file)).exists(), `${name} -> ${file} exists`).toBe(true);
      expect(packed.has(file), `${name} -> ${file} is packed`).toBe(true);
    }
  });

  test("the bin is shipped and starts with the bun shebang", async () => {
    const file = pkg.bin["orcid-mock"];
    expect((await packedFiles()).includes(file)).toBe(true);
    expect((await Bun.file(join(ROOT, file)).text()).startsWith("#!/usr/bin/env bun\n")).toBe(true);
  });

  test("the package imports itself through its own exports map", async () => {
    // Bun resolves a package's own name through `exports`, so these are the paths a consumer uses.
    const app = await import("@nemarorg/orcid-mock");
    expect(typeof app.createApp).toBe("function");
    const bootstrap = await import("@nemarorg/orcid-mock/bootstrap");
    expect(typeof bootstrap.createMockApp).toBe("function");
    const server = await import("@nemarorg/orcid-mock/server");
    expect(typeof server.startServer).toBe("function");
    const schema = await import("@nemarorg/orcid-mock/fixtures/users.schema.json", {
      with: { type: "json" },
    });
    expect(schema.default.$schema).toContain("json-schema.org");
    const example = await import("@nemarorg/orcid-mock/fixtures/users.example.json", {
      with: { type: "json" },
    });
    expect(Array.isArray(example.default.users)).toBe(true);
  });

  test("tests, scripts, and workflows stay out of the tarball", async () => {
    for (const file of await packedFiles()) {
      expect(file).toMatch(
        /^(src\/|fixtures\/users\.(schema|example)\.json$|package\.json$|README\.md$|LICENSE$)/,
      );
    }
  });
});
