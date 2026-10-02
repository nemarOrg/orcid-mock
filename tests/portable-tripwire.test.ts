// The Workers runtime rejects random values, outbound requests, and code generation from strings
// while a module is being evaluated. Bun does not, so this test makes Bun reject them too: it
// replaces those APIs with ones that throw, imports every portable module in a child process, and
// expects a clean exit. A second run with a module that does misbehave proves the trap is armed.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000);

const ROOT = join(import.meta.dir, "..");

const ARM = `
const trap = (name) => () => { throw new Error(name + " called at module scope"); };
for (const name of ["getRandomValues", "randomUUID"]) {
  Object.defineProperty(globalThis.crypto, name, { value: trap("crypto." + name), configurable: true, writable: true });
}
globalThis.fetch = trap("fetch");
globalThis.Function = new Proxy(Function, {
  construct: trap("new Function"),
  apply: trap("Function"),
});
`;

async function runChild(modules: string[]): Promise<{ exitCode: number; stderr: string }> {
  const script = `${ARM}
for (const path of ${JSON.stringify(modules)}) await import(path);
process.exit(0);
`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stderr, , exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { exitCode, stderr };
}

/** Every portable module: all of src/ except the two Bun entry points. */
async function portableModules(): Promise<string[]> {
  const found: string[] = [];
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: ROOT })) {
    if (file !== "src/main.ts" && file !== "src/server.ts") found.push(join(ROOT, file));
  }
  return found.sort();
}

describe("the portable layer at module scope", () => {
  test("every portable module imports without randomness, I/O, or code generation", async () => {
    const modules = await portableModules();
    for (const required of [
      "bootstrap",
      "app",
      "store/memory",
      "fixtures/starter",
      "routes/admin",
    ]) {
      expect(modules).toContain(join(ROOT, `src/${required}.ts`));
    }
    const { exitCode, stderr } = await runChild(modules);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("the trap is armed: a module that draws random values or generates code fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orcid-mock-trap-"));
    try {
      const cases: Array<[string, string]> = [
        ["crypto.getRandomValues", "export const x = crypto.getRandomValues(new Uint8Array(1));"],
        ["crypto.randomUUID", "export const x = crypto.randomUUID();"],
        ["fetch", 'export const x = fetch("http://127.0.0.1:1/");'],
        ["new Function", 'export const x = new Function("return 1");'],
      ];
      for (const [name, source] of cases) {
        const path = join(dir, `${name.replace(/\W/g, "-")}.ts`);
        await writeFile(path, source);
        const { exitCode, stderr } = await runChild([path]);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain("called at module scope");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
