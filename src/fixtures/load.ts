// Turns a parsed users file into a Snapshot, and a single user (admin API) into a StoredUser.
// Explicit iDs are reserved first, the rest are minted from a hash of the user's identity so that
// adding a user never changes anyone else's iD, and every missing put-code comes from one counter.
import { isValidOrcidId, mintOrcidId } from "../orcid-id";
import type { Snapshot, Store, StoredClient, StoredUser } from "../store/types";
import {
  crossUserIssues,
  type FixtureUser,
  FixtureUser as FixtureUserSchema,
  formatPath,
  type Issue,
  PUT_CODE_SECTIONS,
  UsersFile,
  type UsersFileData,
} from "./schema";

/** The first put-code assigned when no fixture put-code is higher. */
export const MIN_PUT_CODE = 1000;

export type LoadResult = { ok: true; snapshot: Snapshot } | { ok: false; issues: Issue[] };

function zodIssues(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): Issue[] {
  return error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message }));
}

/** The seed for a user's minted iD: stable under reordering and under adding other users. */
function mintSeed(user: FixtureUser): string {
  const primary = user.emails?.find((email) => email.primary)?.email.toLowerCase() ?? "";
  return `${primary}|${user.name.given_names}|${user.name.family_name ?? ""}`;
}

function* putCodes(user: FixtureUser | StoredUser): Generator<number> {
  for (const section of PUT_CODE_SECTIONS) {
    for (const entry of user[section] ?? []) {
      if (entry.put_code !== undefined) yield entry.put_code;
    }
  }
}

function missingPutCodes(user: FixtureUser): number {
  let missing = 0;
  for (const section of PUT_CODE_SECTIONS) {
    for (const entry of user[section] ?? []) {
      if (entry.put_code === undefined) missing++;
    }
  }
  return missing;
}

/** Stamps dates and fills put-codes; the iD is already decided. */
function normalizeUser(
  user: FixtureUser,
  orcid: string,
  nowMs: number,
  allocPutCode: () => number,
): StoredUser {
  const stamps = { created_ms: nowMs, modified_ms: nowMs };
  const fill = <T extends { put_code?: number | undefined }>(entry: T) => ({
    ...entry,
    put_code: entry.put_code ?? allocPutCode(),
    ...stamps,
  });
  const {
    orcid: _fileOrcid,
    name,
    biography,
    emails,
    other_names,
    addresses,
    keywords,
    external_identifiers,
    researcher_urls,
    employments,
    educations,
    qualifications,
    works,
    fundings,
    peer_reviews,
    ...state
  } = user;
  return {
    orcid,
    ...state,
    name: { ...name, ...stamps },
    ...(biography !== undefined
      ? { biography: biography === null ? null : { ...biography, ...stamps } }
      : {}),
    ...(emails ? { emails: emails.map((email) => ({ ...email, ...stamps })) } : {}),
    ...(other_names ? { other_names: other_names.map(fill) } : {}),
    ...(addresses ? { addresses: addresses.map(fill) } : {}),
    ...(keywords ? { keywords: keywords.map(fill) } : {}),
    ...(external_identifiers ? { external_identifiers: external_identifiers.map(fill) } : {}),
    ...(researcher_urls ? { researcher_urls: researcher_urls.map(fill) } : {}),
    ...(employments ? { employments: employments.map(fill) } : {}),
    ...(educations ? { educations: educations.map(fill) } : {}),
    ...(qualifications ? { qualifications: qualifications.map(fill) } : {}),
    ...(works ? { works: works.map(fill) } : {}),
    ...(fundings ? { fundings: fundings.map(fill) } : {}),
    ...(peer_reviews ? { peer_reviews: peer_reviews.map(fill) } : {}),
  };
}

function normalizeClient(client: UsersFileData["clients"][number]): StoredClient {
  return {
    client_id: client.client_id,
    client_secret: client.client_secret,
    name: client.name ?? client.client_id,
    redirect_uris: [...client.redirect_uris],
    member: client.member ?? false,
  };
}

/**
 * Validates a users file and builds the Snapshot: explicit iDs reserved, the rest minted in file
 * order, put-codes assigned from a counter that starts above the largest fixture put-code.
 */
export function parseUsersFile(input: unknown, nowMs: number): LoadResult {
  const parsed = UsersFile.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const file = parsed.data;

  const taken = new Set<string>();
  for (const user of file.users) {
    if (user.orcid) taken.add(user.orcid);
  }
  const orcids = file.users.map((user) => {
    if (user.orcid) return user.orcid;
    let attempt = 0;
    let candidate = mintOrcidId(mintSeed(user), attempt);
    while (taken.has(candidate)) candidate = mintOrcidId(mintSeed(user), ++attempt);
    taken.add(candidate);
    return candidate;
  });

  const issues: Issue[] = [];
  file.users.forEach((user, i) => {
    if (user.deprecated_to !== undefined && user.deprecated_to === orcids[i]) {
      issues.push({
        path: `users[${i}].deprecated_to`,
        message: "A record cannot be deprecated to itself",
      });
    }
  });
  if (issues.length > 0) return { ok: false, issues };

  let highest = MIN_PUT_CODE - 1;
  for (const user of file.users) {
    for (const code of putCodes(user)) highest = Math.max(highest, code);
  }
  let counter = highest + 1;
  const allocPutCode = () => counter++;

  const users = file.users.map((user, i) =>
    normalizeUser(user, orcids[i] as string, nowMs, allocPutCode),
  );
  return {
    ok: true,
    snapshot: {
      users,
      clients: file.clients.map(normalizeClient),
      next_put_code: counter,
      next_mint_seq: 1,
      loaded_ms: nowMs,
    },
  };
}

export type PrepareResult =
  | { ok: true; user: StoredUser }
  | { ok: false; kind: "invalid"; issues: Issue[] }
  | { ok: false; kind: "conflict" };

/**
 * Validates one user against the same rules as the file, relative to what the store already
 * holds (duplicate email, duplicate put-code), then mints the iD and fills put-codes from the
 * store's counters.
 * `create` (POST) answers `conflict` when an explicit iD exists; `upsert` (PUT) takes the iD from
 * `pathOrcid` and compares against every other user, so replacing a user never conflicts with it.
 */
export async function prepareUser(
  store: Store,
  input: unknown,
  opts: { mode: "create" } | { mode: "upsert"; pathOrcid: string },
  nowMs: number,
): Promise<PrepareResult> {
  const pathOrcid = opts.mode === "upsert" ? opts.pathOrcid : undefined;
  if (pathOrcid !== undefined && !isValidOrcidId(pathOrcid)) {
    return {
      ok: false,
      kind: "invalid",
      issues: [{ path: "orcid", message: `The path ${pathOrcid} is not a valid ORCID iD` }],
    };
  }
  const parsed = FixtureUserSchema.safeParse(input);
  if (!parsed.success) return { ok: false, kind: "invalid", issues: zodIssues(parsed.error) };
  const user = parsed.data;
  if (pathOrcid !== undefined && user.orcid && user.orcid !== pathOrcid) {
    return {
      ok: false,
      kind: "invalid",
      issues: [
        { path: "orcid", message: `Body orcid ${user.orcid} differs from the path ${pathOrcid}` },
      ],
    };
  }

  const existing = await store.listUsers();
  if (
    opts.mode === "create" &&
    user.orcid &&
    existing.some((other) => other.orcid === user.orcid)
  ) {
    return { ok: false, kind: "conflict" };
  }

  // The same rules as the file, with the new user placed after every other user in the store.
  const others = existing.filter((other) => other.orcid !== pathOrcid);
  const candidate = { ...user, orcid: pathOrcid ?? user.orcid };
  const issues = crossUserIssues([...others, candidate])
    .filter((issue) => issue.path[1] === others.length && issue.path[2] !== "orcid")
    .map((issue) => ({ path: formatPath(issue.path.slice(2)), message: issue.message }));
  if (issues.length > 0) return { ok: false, kind: "invalid", issues };

  let orcid = pathOrcid ?? user.orcid ?? "";
  if (orcid === "") {
    const seq = await store.nextMintSeq();
    let attempt = 0;
    orcid = mintOrcidId(`seq:${seq}`, attempt);
    while ((await store.getUser(orcid)) !== null) orcid = mintOrcidId(`seq:${seq}`, ++attempt);
    if (user.deprecated_to === orcid) {
      return {
        ok: false,
        kind: "invalid",
        issues: [{ path: "deprecated_to", message: "A record cannot be deprecated to itself" }],
      };
    }
  }

  // Draw one put-code per missing one, skipping any already used by an explicit put-code.
  const used = new Set<number>(putCodes(user));
  for (const other of others) for (const code of putCodes(other)) used.add(code);
  const drawn: number[] = [];
  for (let need = missingPutCodes(user); need > 0; ) {
    const code = await store.nextPutCode();
    if (!used.has(code)) {
      drawn.push(code);
      need--;
    }
  }
  const stored = normalizeUser(user, orcid, nowMs, () => drawn.shift() as number);
  return { ok: true, user: stored };
}

/** A stored user in fixture form: the stamps are the store's, not part of the file format. */
export function toFixtureUser(user: StoredUser): FixtureUser {
  return stripStamps(user) as FixtureUser;
}

function stripStamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripStamps);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "created_ms" || key === "modified_ms") continue;
      out[key] = stripStamps(inner);
    }
    return out;
  }
  return value;
}
