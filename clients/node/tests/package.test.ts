// What the published package promises. The package ships compiled JavaScript with declarations
// (ADR 0008), so these tests build it, pack it, install the tarball into a temporary project, and
// load it the way a consumer does: under Node, which is the runtime that refuses TypeScript from
// `node_modules`, and under the TypeScript compiler's Node-style module resolution. Real files, a
// real install, and a real Node process; nothing is stubbed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

setDefaultTimeout(300_000);

const ROOT = join(import.meta.dir, "..");

/** The environment a child gets: a PATH and a HOME, so repeated runs do not depend on the shell. */
const childEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1" };

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function run(command: string[], cwd: string): Promise<Ran> {
  const child = Bun.spawn(command, {
    cwd,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function mustRun(command: string[], cwd: string): Promise<string> {
  const ran = await run(command, cwd);
  if (ran.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited ${ran.exitCode}\n${ran.stdout}\n${ran.stderr}`);
  }
  return ran.stdout;
}

/** The files `bun pm pack --dry-run` would put in the tarball. */
async function packedFiles(): Promise<string[]> {
  const stdout = await mustRun([process.execPath, "pm", "pack", "--dry-run"], ROOT);
  return [...stdout.matchAll(/^packed\s+\S+\s+(\S+)\s*$/gm)].map((match) => match[1] as string);
}

let work: string;
let tarball: string;
/** A project with the packed tarball and the optional peers installed. */
let consumer: string;

beforeAll(async () => {
  expect(
    Bun.which("node"),
    "Node must be on PATH: the package has to load under it",
  ).not.toBeNull();
  await mustRun([process.execPath, "run", "build"], ROOT);

  work = await mkdtemp(join(tmpdir(), "orcid-mock-package-"));
  await mustRun([process.execPath, "pm", "pack", "--destination", work], ROOT);
  const packed = (await readdir(work)).find((name) => name.endsWith(".tgz"));
  if (packed === undefined) throw new Error("bun pm pack wrote no tarball");
  tarball = join(work, packed);

  consumer = join(work, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  await mustRun(
    [
      process.execPath,
      "add",
      `file:${tarball}`,
      `testcontainers@${pkg.devDependencies.testcontainers}`,
      `@playwright/test@${pkg.devDependencies["@playwright/test"]}`,
    ],
    consumer,
  );
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

describe("the npm package", () => {
  test("every export target is shipped, declarations included", async () => {
    const packed = new Set(await packedFiles());
    for (const [name, target] of Object.entries(pkg.exports)) {
      for (const file of [target.types, target.default].map((path) => path.replace(/^\.\//, ""))) {
        expect(await Bun.file(join(ROOT, file)).exists(), `${name} -> ${file} exists`).toBe(true);
        expect(packed.has(file), `${name} -> ${file} is packed`).toBe(true);
      }
    }
  });

  test("the README and the license are shipped", async () => {
    const packed = new Set(await packedFiles());
    expect(packed.has("README.md")).toBe(true);
    expect(packed.has("LICENSE")).toBe(true);
  });

  test("sources, tests, configuration, and lockfiles stay out of the tarball", async () => {
    for (const file of await packedFiles()) {
      expect(file).toMatch(/^(dist\/[\w-]+(\.d)?\.(js|ts)|package\.json|README\.md|LICENSE)$/);
    }
  });

  test("the installed package loads under Node, and its entry points are what they claim", async () => {
    const script = `
      const client = await import("@nemarorg/orcid-mock-testing/client");
      const containers = await import("@nemarorg/orcid-mock-testing/testcontainers");
      const playwright = await import("@nemarorg/orcid-mock-testing/playwright");
      console.log(JSON.stringify({
        client: typeof client.OrcidMockClient,
        error: typeof client.OrcidMockError,
        container: typeof containers.OrcidMockContainer,
        startError: typeof containers.OrcidMockStartError,
        startOrConnect: typeof containers.startOrConnect,
        signInAs: typeof playwright.signInAs,
        test: typeof playwright.test?.extend,
      }));
    `;
    const ran = await run(["node", "--input-type=module", "-e", script], consumer);
    expect(ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      client: "function",
      error: "function",
      container: "function",
      startError: "function",
      startOrConnect: "function",
      signInAs: "function",
      test: "function",
    });
  });

  test("the client entry loads in a project that installed no peer dependency", async () => {
    const bare = join(work, "bare");
    await mkdir(bare);
    await writeFile(
      join(bare, "package.json"),
      JSON.stringify({ name: "bare", private: true, type: "module" }),
    );
    await mustRun([process.execPath, "add", `file:${tarball}`], bare);
    const ran = await run(
      [
        "node",
        "--input-type=module",
        "-e",
        `import { OrcidMockClient } from "@nemarorg/orcid-mock-testing/client";
         console.log(new OrcidMockClient("http://localhost:1/").baseUrl);`,
      ],
      bare,
    );
    expect(ran.stderr).toBe("");
    expect(ran.stdout.trim()).toBe("http://localhost:1");
  });

  test("the declarations resolve for a consumer using Node's module resolution", async () => {
    await writeFile(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["check.ts"],
      }),
    );
    // If a declaration failed to resolve, its types would be `any`, the directives below would be
    // unused, and the compiler would say so.
    await writeFile(
      join(consumer, "check.ts"),
      `import { OrcidMockClient, type OrcidMockTokenResponse } from "@nemarorg/orcid-mock-testing/client";
import { OrcidMockContainer, type StartedOrcidMockContainer } from "@nemarorg/orcid-mock-testing/testcontainers";
import { signInAs, test } from "@nemarorg/orcid-mock-testing/playwright";

const client = new OrcidMockClient("http://localhost:1");
const offset: Promise<number> = client.advanceClock(1);
const token: Promise<OrcidMockTokenResponse> = client.signIn({ orcid: "0000-0002-1825-0097" });
// @ts-expect-error the client has no such method
client.nope();
// @ts-expect-error advanceClock takes seconds
client.advanceClock("5");
const container: OrcidMockContainer = new OrcidMockContainer();
const started: Promise<StartedOrcidMockContainer> = container.withUsers("users.json").start();
// @ts-expect-error a started container has a base URL, not a basePath
started.then((s) => s.basePath);
export { offset, token, started, signInAs, test };
`,
    );
    const tsc = join(ROOT, "node_modules", ".bin", "tsc");
    const ran = await run([tsc, "-p", "tsconfig.json"], consumer);
    expect(ran.stdout + ran.stderr).toBe("");
    expect(ran.exitCode).toBe(0);
  });

  test("the version is the server's, since helpers release in lockstep", async () => {
    const server = (await Bun.file(join(ROOT, "..", "..", "package.json")).json()) as {
      version: string;
    };
    expect(pkg.version).toBe(server.version);
  });
});
