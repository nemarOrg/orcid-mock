// The name ORCID shows next to an iD without asking the user's permission.
import type { StoredUser } from "../store/types";

/**
 * ORCID's public display name, the `name` of a token response: the credit name if the name is
 * public and a credit name exists, else the given and family names joined by a space (a blank
 * part left out) if the name is public, else the empty string. `getPublicName` and `buildName`
 * are ORCID's rule, which yields null for a name that is not public:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/utils/RecordNameUtils.java#L11-L22
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/utils/RecordNameUtils.java#L47-L59
 * and `retrivePublicDisplayName`, which the token response uses, turns that null into "":
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/impl/ProfileEntityManagerImpl.java#L377-L380
 */
export function publicDisplayName(user: StoredUser): string {
  const { name } = user;
  if (name.visibility !== "public") return "";
  if (!isBlank(name.credit_name)) return name.credit_name as string;
  return [name.given_names, name.family_name].filter((part) => !isBlank(part)).join(" ");
}

/** The name fields an OpenID Connect response carries; each is null when it is not shared. */
export interface PublicNameClaims {
  /** The credit name, which is what both `name` claims are in ORCID. */
  name: string | null;
  family_name: string | null;
  given_name: string | null;
}

/**
 * The name claims of an ID token and of userinfo: each field of a public name that exists, and
 * nothing at all for a name that is not public. ORCID reads them from the record's public person
 * details, `name` being the credit name only (no fallback to the given and family names, unlike
 * the token response's display name above):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/oauth/openid/OpenIDConnectUserInfo.java#L33-L46
 * https://github.com/ORCID/ORCID-Source/blob/7eeb1e7709760f328f5d3f72ebf2629f0a5d54c9/orcid-core/src/main/java/org/orcid/core/oauth/openid/OpenIDConnectTokenEnhancer.java#L120-L131
 * A blank field counts as absent, as it does for the display name.
 */
export function publicNameClaims(user: StoredUser): PublicNameClaims {
  const { name } = user;
  const shared = (value: string | null | undefined): string | null =>
    name.visibility === "public" && !isBlank(value) ? (value as string) : null;
  return {
    name: shared(name.credit_name),
    family_name: shared(name.family_name),
    given_name: shared(name.given_names),
  };
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}
