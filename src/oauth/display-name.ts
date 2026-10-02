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

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}
