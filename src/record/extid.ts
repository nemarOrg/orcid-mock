// External identifiers on activities: how they are normalized, which of them group items, and how
// they are written. (The person-level external identifiers are a different shape; see
// person.ts.)
import type { FixtureExternalId } from "../fixtures/schema";
import type { Json, JsonObject } from "./json";
import { wrap } from "./wire";

/**
 * `normalized` writes ORCID's `external-id-normalized` and `external-id-normalized-error`;
 * `plain` writes both null. orcid-mock choice, from observation: works, affiliations, and peer
 * reviews carry a normalized value, while fundings write null for every id (the live funding
 * ids and the `orcid-model` funding sample both show `"external-id-normalized": null`).
 */
export type IdMode = "normalized" | "plain";

export interface Normalization {
  value: string | null;
  /** True when ORCID's normalizer rejects the value, which it reports as error 8001. */
  failed: boolean;
}

// ORCID's DOI normalizer keeps the `10.<registrant>/<suffix>` part of the value, dropping a
// `https://doi.org/` or `doi:` prefix, and answers "" when there is none:
// https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/utils/v3/identifiers/normalizers/DOINormalizer.java#L17
const DOI_PATTERN = /(10(?:\.[0-9a-zA-Z]+)+\/(?:(?!["&'])\S)+)/;

/**
 * The normalized value of an id, as `PIDNormalizationService.normalise` computes it:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/adapter/mapstruct/JSONExternalIdentifiersMapperV3.java#L75-L96
 * orcid-mock choice: only `doi` has a normalizer here, which lowercases (ORCID's identifier-type
 * table marks DOIs case-insensitive, so the first normalizer lowercases them) and then applies
 * the pattern above; every other type is unchanged, though ORCID also reformats ISSNs, ISBNs,
 * arXiv ids, and a few more (and lowercases the other case-insensitive types).
 * A DOI the pattern rejects has no normalized value and the 8001 error.
 */
export function normalizeId(type: string, value: string): Normalization {
  if (type !== "doi") return { value, failed: false };
  const match = DOI_PATTERN.exec(value.toLowerCase());
  return match?.[1] === undefined
    ? { value: null, failed: true }
    : { value: match[1], failed: false };
}

/**
 * ORCID's group id for an id: the normalized value when there is one, else the raw value, then
 * the type, so two DOIs that differ only in case are one key
 * (`ExternalID.getGroupId`, in orcid-model):
 * https://github.com/ORCID/orcid-model/blob/9592e2d3bde21a1edf703f26f8bc304448f886fb/src/main/java/org/orcid/jaxb/model/v3/release/record/ExternalID.java#L126-L135
 */
export function groupId(id: FixtureExternalId, mode: IdMode): string {
  const normalized =
    mode === "normalized" ? normalizeId(id.external_id_type, id.external_id_value) : null;
  return `${normalized?.value ?? id.external_id_value}${id.external_id_type}`;
}

/**
 * Whether an id can key a group: not a `part-of` or `funded-by` id, and not empty
 * (`ExternalID.isGroupAble`). A missing relationship groups, and so does `version-of`:
 * https://github.com/ORCID/orcid-model/blob/9592e2d3bde21a1edf703f26f8bc304448f886fb/src/main/java/org/orcid/jaxb/model/v3/release/record/ExternalID.java#L139-L149
 */
export function isGroupable(id: FixtureExternalId): boolean {
  const relationship = id.external_id_relationship;
  return relationship !== "part-of" && relationship !== "funded-by" && id.external_id_value !== "";
}

/**
 * One id as ORCID writes it, six keys in this order. `external-id-url` is `{ value }` or null,
 * and the relationship is a string or null; the error shape is `{ error-code: "8001",
 * error-message, transient: true }` with the code as a string, as in `orcid-model`'s sample:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/resources/i18n/api_en.properties#L241-L242
 */
export function externalIdJson(id: FixtureExternalId, mode: IdMode): JsonObject {
  const normalized: Normalization | null =
    mode === "normalized" ? normalizeId(id.external_id_type, id.external_id_value) : null;
  return {
    "external-id-type": id.external_id_type,
    "external-id-value": id.external_id_value,
    "external-id-normalized":
      normalized?.value === null || normalized === null
        ? null
        : { value: normalized.value, transient: true },
    "external-id-normalized-error": normalized?.failed
      ? {
          "error-code": "8001",
          "error-message": `Cannot normalize identifier value ${id.external_id_type}:${id.external_id_value}`,
          transient: true,
        }
      : null,
    "external-id-url": wrap(id.external_id_url),
    "external-id-relationship": id.external_id_relationship ?? null,
  };
}

/**
 * The `external-ids` of a summary or an item: `{ "external-id": [...] }`, or null when there are
 * none (observed on affiliation summaries; orcid-mock extends it to every kind). A group's own
 * `external-ids` is `{ "external-id": [] }` when empty instead; see `groupIdsJson`.
 */
export function idsJson(
  ids: readonly FixtureExternalId[] | undefined,
  mode: IdMode,
): JsonObject | null {
  if (ids === undefined || ids.length === 0) return null;
  return { "external-id": ids.map((id) => externalIdJson(id, mode)) };
}

/** A group's `external-ids`: the group keys, always an object, with an empty list for none. */
export function groupIdsJson(keys: readonly FixtureExternalId[], mode: IdMode): Json {
  return { "external-id": keys.map((id) => externalIdJson(id, mode)) };
}
