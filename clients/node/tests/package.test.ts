// What the published package promises: every entry point resolves to a file that `files` ships,
// the package imports itself through its own exports map (the paths a consumer uses), and nothing
// but sources, the manifest, the README, and the license is shipped. Real files and a real dry-run
// pack; nothing is stubbed.
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

  test("the README and the license are shipped", async () => {
    const packed = new Set(await packedFiles());
    expect(packed.has("README.md")).toBe(true);
    expect(packed.has("LICENSE")).toBe(true);
  });

  test("tests, configuration, and lockfiles stay out of the tarball", async () => {
    for (const file of await packedFiles()) {
      expect(file).toMatch(/^(src\/[\w-]+\.ts|package\.json|README\.md|LICENSE)$/);
    }
  });

  test("the package imports itself through its own exports map", async () => {
    const client = await import("@nemarorg/orcid-mock-testing/client");
    expect(typeof client.OrcidMockClient).toBe("function");
    const containers = await import("@nemarorg/orcid-mock-testing/testcontainers");
    expect(typeof containers.OrcidMockContainer).toBe("function");
    expect(typeof containers.startOrConnect).toBe("function");
    const playwright = await import("@nemarorg/orcid-mock-testing/playwright");
    expect(typeof playwright.signInAs).toBe("function");
    expect(typeof playwright.test.extend).toBe("function");
  });

  test("the version is the server's, since helpers release in lockstep", async () => {
    const server = (await Bun.file(join(ROOT, "..", "..", "package.json")).json()) as {
      version: string;
    };
    expect(pkg.version).toBe(server.version);
  });
});
