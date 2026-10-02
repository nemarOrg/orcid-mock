// Decides which floating tags a release may move, so that none ever moves backwards.
//
// The floating tags are the image tags `latest`, `<major>`, and `<major>.<minor>`, and the git tag
// `v<major>` that `uses: nemarOrg/orcid-mock@v<major>` follows. A release moves one only when it
// is the highest stable version that tag could point to: `latest` against every stable version,
// `<major>` against the versions of its major, `<major>.<minor>` against the versions of its minor.
// A prerelease moves none of them.
//
//   git tag --list | bun scripts/floating-tags.ts --version 1.2.3
//
// reads the existing tags from standard input (one per line; anything that is not `vX.Y.Z` is
// ignored) and prints `latest=`, `major=`, and `minor=` lines, each `true` or `false`, ready to
// append to $GITHUB_OUTPUT. The version being released counts even if its tag is not in the list,
// which is the case in a dry run.
import { parseArgs } from "node:util";

export interface Moves {
  latest: boolean;
  major: boolean;
  minor: boolean;
}

type Triple = readonly [major: number, minor: number, patch: number];

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

/** `X.Y.Z` with no prerelease or build part, or null. */
function parseStable(version: string): Triple | null {
  const match = STABLE.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Which floating tags releasing `version` may move, given the tags that already exist.
 * `tags` are git tags such as `v1.2.3`; prereleases and anything else are ignored.
 */
export function floatingMoves(version: string, tags: readonly string[]): Moves {
  const released = parseStable(version);
  if (released === null) return { latest: false, major: false, minor: false };

  const stable: Triple[] = [];
  for (const tag of tags) {
    const parsed = tag.startsWith("v") ? parseStable(tag.slice(1)) : null;
    if (parsed !== null) stable.push(parsed);
  }
  const noneHigher = (inScope: (other: Triple) => boolean): boolean =>
    stable.every((other) => !inScope(other) || compare(released, other) >= 0);
  return {
    latest: noneHigher(() => true),
    major: noneHigher((other) => other[0] === released[0]),
    minor: noneHigher((other) => other[0] === released[0] && other[1] === released[1]),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { version: { type: "string" } } });
  if (values.version === undefined) throw new Error("usage: floating-tags --version X.Y.Z < tags");
  const tags = (await Bun.stdin.text()).split("\n").map((line) => line.trim());
  const moves = floatingMoves(values.version, tags);
  console.log(`latest=${moves.latest}\nmajor=${moves.major}\nminor=${moves.minor}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
