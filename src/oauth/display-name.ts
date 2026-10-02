// The name ORCID shows next to an iD without asking the user's permission.
import type { StoredUser } from "../store/types";

/**
 * ORCID's public display name, the `name` of a token response: the credit name if the name is
 * public and a credit name exists, else the given and family names joined by a space and trimmed
 * if the name is public, else the empty string. Legacy `retrivePublicDisplayName` in
 * ORCID-Source (research 2.2); the `"name":"Sofia Garcia "` in ORCID's own documentation shows
 * the join before the trim.
 */
export function publicDisplayName(user: StoredUser): string {
  const { name } = user;
  if (name.visibility !== "public") return "";
  const credit = name.credit_name?.trim();
  if (credit) return credit;
  return `${name.given_names} ${name.family_name ?? ""}`.trim();
}
