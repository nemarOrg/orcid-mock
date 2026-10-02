// Compiles src/main.ts into one standalone binary per platform with `bun build --compile`, and
// writes dist/SHA256SUMS next to them. Every binary embeds the Bun runtime, the dependencies, the
// starter fixture (a TypeScript constant), and the version from package.json, so nothing needs
// installing to run one.
//
//   bun scripts/build-binaries.ts                          every target
//   bun scripts/build-binaries.ts --target linux-x64       one or more targets (repeat the flag)
//   bun scripts/build-binaries.ts --out some/dir           default: dist
//
// Cross-compiling downloads the target's Bun runtime on first use, so the machine needs network
// access unless the target matches the host. Nothing here publishes anything.
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

interface Target {
  /** The suffix of the output file and the value of --target. */
  name: string;
  /** What `bun build --target` calls it. */
  bun: string;
  /** Windows binaries carry .exe. */
  ext: string;
}

const TARGET_NAMES = [
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
  "windows-arm64",
] as const;

export const TARGETS: readonly Target[] = TARGET_NAMES.map((name) => ({
  name,
  bun: `bun-${name}`,
  ext: name.startsWith("windows-") ? ".exe" : "",
}));

const ROOT = resolve(import.meta.dir, "..");

/** `-baseline` and `-modern` resolve to the same binary in Bun 1.4, so they are not built. */
async function compile(target: Target, outDir: string): Promise<string> {
  const outfile = join(outDir, `orcid-mock-${target.name}${target.ext}`);
  console.log(`building ${outfile}`);
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "src/main.ts",
      "--compile",
      "--minify",
      `--target=${target.bun}`,
      // A binary run from an arbitrary directory must not pick up that directory's .env or
      // bunfig.toml: the server is configured by flags and PUBLIC_BASE_URL and friends only.
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      outfile,
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit", stdin: "ignore" },
  );
  const code = await child.exited;
  if (code !== 0) throw new Error(`bun build failed for ${target.name} (exit ${code})`);
  return outfile;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

/** `sha256sum -c` format: the digest, two spaces, the bare file name; sorted, one per line. */
async function writeChecksums(outDir: string): Promise<string[]> {
  const names = (await readdir(outDir)).filter((name) => name.startsWith("orcid-mock-")).sort();
  const lines = await Promise.all(
    names.map(async (name) => `${await sha256(join(outDir, name))}  ${name}`),
  );
  await Bun.write(join(outDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return lines;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { target: { type: "string", multiple: true }, out: { type: "string" } },
  });
  const wanted = values.target ?? [];
  const targets: Target[] = [];
  for (const name of wanted.length === 0 ? TARGET_NAMES : wanted) {
    const target = TARGETS.find((candidate) => candidate.name === name);
    if (target === undefined) {
      throw new Error(
        `unknown target ${JSON.stringify(name)}; choose from ${TARGET_NAMES.join(", ")}`,
      );
    }
    targets.push(target);
  }

  const outDir = resolve(ROOT, values.out ?? "dist");
  await mkdir(outDir, { recursive: true });
  for (const target of targets) await compile(target, outDir);
  const lines = await writeChecksums(outDir);
  console.log(`\n${join(outDir, "SHA256SUMS")}\n${lines.join("\n")}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
