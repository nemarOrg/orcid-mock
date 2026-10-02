// Affiliations: employments, educations, and qualifications, which the fixture holds, and the four
// kinds it has no section for (distinctions, invited positions, memberships, services), whose
// containers are always empty. They share one shape in ORCID's model.
import type { StoredUser } from "../store/types";
import { groupIdsJson, idsJson } from "./extid";
import { groupItems } from "./groups";
import type { JsonObject } from "./json";
import { affiliationOrder, byDisplayIndex } from "./order";
import { canSee, type Viewer } from "./viewer";
import {
  type Built,
  fuzzyDate,
  type ItemLookup,
  maxMs,
  organization,
  selfSource,
  stamp,
  stampOrNull,
  text,
  wrap,
} from "./wire";

type StoredAffiliation = NonNullable<StoredUser["employments"]>[number];

export type AffiliationKind =
  | "employment"
  | "education"
  | "qualification"
  | "distinction"
  | "invited-position"
  | "membership"
  | "service";

interface KindConfig {
  /** The container's path segment, plural. */
  segment: string;
  list(user: StoredUser): readonly StoredAffiliation[] | undefined;
}

const KINDS: Record<AffiliationKind, KindConfig> = {
  employment: { segment: "employments", list: (user) => user.employments },
  education: { segment: "educations", list: (user) => user.educations },
  qualification: { segment: "qualifications", list: (user) => user.qualifications },
  // The fixture has no section for these, so they are always empty.
  distinction: { segment: "distinctions", list: () => undefined },
  "invited-position": { segment: "invited-positions", list: () => undefined },
  membership: { segment: "memberships", list: () => undefined },
  service: { segment: "services", list: () => undefined },
};

/**
 * The summary inside a group: `created-date`, `last-modified-date`, `source`, `put-code`, the
 * affiliation's own fields, then `display-index` as a string, `visibility`, and `path`, which
 * uses the singular kind (`/employment/4288`). `external-ids` is null when there are none
 * (observed on pub.orcid.org/v3.0 on 2026-10-01 for employments and educations).
 */
function summary(
  user: StoredUser,
  viewer: Viewer,
  kind: AffiliationKind,
  item: StoredAffiliation,
): JsonObject {
  return {
    "created-date": stamp(item.created_ms),
    "last-modified-date": stamp(item.modified_ms),
    source: selfSource(user, viewer),
    "put-code": item.put_code,
    "department-name": text(item.department_name),
    "role-title": text(item.role_title),
    "start-date": fuzzyDate(item.start_date),
    "end-date": fuzzyDate(item.end_date),
    organization: organization(item.organization),
    url: wrap(item.url),
    "external-ids": idsJson(item.external_ids, "normalized"),
    "display-index": String(item.display_index ?? 0),
    visibility: item.visibility,
    path: `/${user.orcid}/${kind}/${item.put_code}`,
  };
}

/**
 * A container of one kind. The visible items are sorted by ORCID's date string, then grouped by
 * external id, and each group's summaries are ordered by display index; a group with no visible
 * member is gone, and every date is recomputed from what survives:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/AffiliationsManagerReadOnlyImpl.java#L161-L170
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/AffiliationsManagerReadOnlyImpl.java#L403-L446
 * `affiliation-group` entries are `{ last-modified-date, external-ids, summaries }`, and each
 * entry of `summaries` is a one-key object, `{ "<kind>-summary": {...} }` (observed).
 */
export function affiliations(user: StoredUser, viewer: Viewer, kind: AffiliationKind): Built {
  const config = KINDS[kind];
  const visible = affiliationOrder(
    (config.list(user) ?? []).filter((item) => canSee(viewer, item.visibility)),
  );
  const groups = groupItems(visible, (item) => item.external_ids, "normalized").map((group) => {
    const members = byDisplayIndex(group.members);
    const lastMs = maxMs(members.map((member) => member.modified_ms));
    return {
      lastMs,
      json: {
        "last-modified-date": stampOrNull(lastMs),
        "external-ids": groupIdsJson(group.keys, "normalized"),
        summaries: members.map((member) => ({
          [`${kind}-summary`]: summary(user, viewer, kind, member),
        })),
      },
    };
  });
  const lastMs = maxMs(groups.map((group) => group.lastMs));
  return {
    json: {
      "last-modified-date": stampOrNull(lastMs),
      "affiliation-group": groups.map((group) => group.json),
      path: `/${user.orcid}/${config.segment}`,
    },
    lastMs,
  };
}

/**
 * One affiliation by put-code, as ORCID's full item: `created-date`, `last-modified-date`,
 * `source`, `put-code`, `path`, then the same fields as the summary, with `display-index` last
 * but for `visibility` (observed on pub.orcid.org/v3.0 on 2026-10-01). ORCID's affiliations share
 * one table, so a put-code is found whatever its kind, and one of another kind is a 400 / 9006
 * (`Given affiliation <pc> doesn't match the desired type <kind>`) before visibility is
 * considered (source only):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/AffiliationsManagerReadOnlyImpl.java#L97-L101
 * A put-code that is in none of this record's affiliations is missing, and one the viewer may
 * not see is hidden. A fixture's put-codes are unique only within a section, so the section of
 * the kind asked for is tried first.
 */
export function affiliationItem(
  user: StoredUser,
  viewer: Viewer,
  kind: AffiliationKind,
  putCode: number,
): ItemLookup {
  const item = (KINDS[kind].list(user) ?? []).find((candidate) => candidate.put_code === putCode);
  if (item === undefined) {
    const other = (Object.keys(KINDS) as AffiliationKind[]).some((otherKind) =>
      (KINDS[otherKind].list(user) ?? []).some((candidate) => candidate.put_code === putCode),
    );
    return other
      ? {
          kind: "bad-request",
          detail: `Given affiliation ${putCode} doesn't match the desired type ${kind}`,
        }
      : { kind: "missing" };
  }
  if (!canSee(viewer, item.visibility)) return { kind: "hidden" };
  return {
    kind: "ok",
    json: {
      "created-date": stamp(item.created_ms),
      "last-modified-date": stamp(item.modified_ms),
      source: selfSource(user, viewer),
      "put-code": item.put_code,
      path: `/${user.orcid}/${kind}/${item.put_code}`,
      "department-name": text(item.department_name),
      "role-title": text(item.role_title),
      "start-date": fuzzyDate(item.start_date),
      "end-date": fuzzyDate(item.end_date),
      organization: organization(item.organization),
      url: wrap(item.url),
      "external-ids": idsJson(item.external_ids, "normalized"),
      "display-index": String(item.display_index ?? 0),
      visibility: item.visibility,
    },
  };
}
