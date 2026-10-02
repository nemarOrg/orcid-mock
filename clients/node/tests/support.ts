// Shared by the tests: a real orcid-mock started from this repository's source, as a child
// process, which is how the `ORCID_MOCK_URL` mode is exercised without a container.
import { join } from "node:path";

/** The repository root, two directories above clients/node. */
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

export interface RepoServer {
  url: string;
  stop(): Promise<void>;
}

/**
 * Runs `bun run src/main.ts serve --port 0` from the repository and resolves with the URL it
 * reports on its readiness line. The child gets no inherited ORCID-mock settings.
 */
export async function startRepoServer(): Promise<RepoServer> {
  const child = Bun.spawn(
    [process.execPath, "run", join(REPO_ROOT, "src/main.ts"), "serve", "--port", "0"],
    {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    },
  );

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);
    if (next === null) continue;
    if (next.done) break;
    seen += decoder.decode(next.value);
    const line = seen.split("\n").find((candidate) => candidate.includes('"event":"listening"'));
    if (line !== undefined) {
      reader.releaseLock();
      const { url } = JSON.parse(line) as { url: string };
      return {
        url,
        stop: async () => {
          child.kill("SIGTERM");
          await child.exited;
        },
      };
    }
  }
  child.kill("SIGKILL");
  throw new Error(`the repository server printed no readiness line; stdout so far: ${seen}`);
}

/** Runs `body` with `name` set (or unset when `value` is undefined), then restores it. */
export async function withEnv<T>(
  name: string,
  value: string | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}
