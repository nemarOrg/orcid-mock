// Who is reading a record, and what that reader may see.
import type { StoredUser, TokenRecord, Visibility } from "../store/types";

/**
 * `public` sees only `public` items; `limited` also sees `limited` ones. `private` is never
 * served. `baseUrl` is `PUBLIC_BASE_URL`, the origin of every absolute URL in the response.
 */
export interface Viewer {
  level: "public" | "limited";
  baseUrl: string;
}

/**
 * Whether the reader sees an item with this visibility: the public API shows only `public`
 * items (`checkIsPublic` throws for anything else), and `limited` is invisible to it exactly
 * like `private`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/publicV3/server/security/impl/PublicAPISecurityManagerV3Impl.java#L48-L52
 * orcid-mock choice: a reader holding a `/read-limited` token (see `viewerFor`) also sees
 * `limited` items, which ORCID serves on its member API host (api.orcid.org), a separate code
 * path that was not observed.
 */
export function canSee(viewer: Viewer, visibility: Visibility): boolean {
  return visibility === "public" || (viewer.level === "limited" && visibility === "limited");
}

/**
 * The viewer for a request: `limited` when the token carries `/read-limited` and belongs to the
 * record's own iD; otherwise `public`. Membership is not checked here: the authorize endpoint
 * refuses `/read-limited` to a client that is not a member (src/oauth/authorize.ts), so only a
 * member client's token can carry it.
 * orcid-mock choice for a token that fails either test (another user's token, a token without
 * the scope, or a client-credentials token): the public view, not an error. ORCID's member API
 * host, where `/read-limited` applies, was not observed.
 */
export function viewerFor(
  token: TokenRecord | null,
  user: Pick<StoredUser, "orcid">,
  baseUrl: string,
): Viewer {
  const limited =
    token !== null && token.orcid === user.orcid && token.scopes.includes("/read-limited");
  return { level: limited ? "limited" : "public", baseUrl };
}
