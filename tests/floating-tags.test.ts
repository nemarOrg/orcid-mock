// The rule that no floating tag (latest, MAJOR, MAJOR.MINOR, and the Action's v<major>) ever moves
// backwards, tested on real tag lists, and once end to end through the command a workflow runs.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { floatingMoves } from "../scripts/floating-tags";

const ALL = { latest: true, major: true, minor: true };
const NONE = { latest: false, major: false, minor: false };

describe("floatingMoves", () => {
  test("the first release moves everything", () => {
    expect(floatingMoves("1.0.0", [])).toEqual(ALL);
    expect(floatingMoves("1.0.0", ["v1.0.0"])).toEqual(ALL);
  });

  test("the next release in line moves everything", () => {
    expect(floatingMoves("1.1.0", ["v1.0.0", "v1.0.1"])).toEqual(ALL);
    expect(floatingMoves("1.0.2", ["v1.0.0", "v1.0.1", "v1.0.2"])).toEqual(ALL);
  });

  test("a patch for an older minor moves only its own minor, not major or latest", () => {
    // 1.2.0 exists, so 1.1.5 must not take :1 or latest, but :1.1 should follow the patch.
    expect(floatingMoves("1.1.5", ["v1.1.4", "v1.2.0", "v1.1.5"])).toEqual({
      latest: false,
      major: false,
      minor: true,
    });
  });

  test("a patch for an older major moves its major and minor, not latest", () => {
    expect(floatingMoves("1.4.2", ["v1.4.1", "v1.4.2", "v2.0.0"])).toEqual({
      latest: false,
      major: true,
      minor: true,
    });
  });

  test("re-releasing the highest version is a no-op that still allows the moves", () => {
    expect(floatingMoves("2.0.0", ["v1.9.9", "v2.0.0"])).toEqual(ALL);
  });

  test("an older version moves nothing once a newer patch of the same minor exists", () => {
    expect(floatingMoves("1.0.1", ["v1.0.1", "v1.0.2"])).toEqual(NONE);
  });

  test("versions compare numerically, not as text", () => {
    expect(floatingMoves("1.10.0", ["v1.9.0", "v1.10.0"])).toEqual(ALL);
    expect(floatingMoves("1.9.0", ["v1.9.0", "v1.10.0"])).toEqual({
      latest: false,
      major: false,
      minor: true,
    });
  });

  test("a prerelease moves nothing, whatever exists", () => {
    expect(floatingMoves("2.0.0-rc.1", [])).toEqual(NONE);
    expect(floatingMoves("1.2.3-rc.1", ["v1.0.0"])).toEqual(NONE);
  });

  test("prereleases and other tags never block a release", () => {
    const tags = ["v1.0.0", "v2.0.0-rc.1", "v1", "latest", "release-9", "v1.2", "v1.2.3.4"];
    expect(floatingMoves("1.0.1", tags)).toEqual(ALL);
  });

  test("the version being released counts even when its tag is not in the list", () => {
    expect(floatingMoves("1.0.1", ["v1.0.0"])).toEqual(ALL);
  });
});

describe("the command", () => {
  async function run(version: string, tags: string[]): Promise<string> {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "scripts", "floating-tags.ts"),
        "--version",
        version,
      ],
      { stdin: new Blob([`${tags.join("\n")}\n`]), stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exitCode).toBe(0);
    return stdout;
  }

  test("reads tags on standard input and prints GITHUB_OUTPUT lines", async () => {
    expect(await run("1.1.5", ["v1.1.4", "v1.2.0"])).toBe(
      "latest=false\nmajor=false\nminor=true\n",
    );
    expect(await run("1.2.0", ["v1.1.4", "v1.2.0"])).toBe("latest=true\nmajor=true\nminor=true\n");
  });

  test("without --version it fails with a usage line", async () => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "scripts", "floating-tags.ts")],
      { stdin: new Blob([""]), stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage: floating-tags");
  });
});
