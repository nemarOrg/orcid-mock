// Fundings: the grouped summaries (`/fundings`) and one full funding (`/funding/{put-code}`).

import type { JsonObject } from "../json";
import type { StoredUser } from "../store/types";
import { groupIdsJson, idsJson } from "./extid";
import { groupItems } from "./groups";
import { byDisplayIndex, displayOrder } from "./order";
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
  wrap,
} from "./wire";

type StoredFunding = NonNullable<StoredUser["fundings"]>[number];

/**
 * A funding's title has no `subtitle` key, only `title` and `translated-title` (observed on
 * pub.orcid.org/v3.0 on 2026-10-01).
 */
function titleJson(funding: StoredFunding): JsonObject {
  return {
    title: { value: funding.title },
    "translated-title": funding.translated_title
      ? {
          value: funding.translated_title.value,
          "language-code": funding.translated_title.language_code,
        }
      : null,
  };
}

/**
 * A funding summary: fourteen keys with `visibility` before `put-code` and `path`, and
 * `display-index` a string last (observed). The ids are written `plain`: a funding id has no
 * normalized value (observed on live fundings and in the `orcid-model` sample).
 */
function summary(user: StoredUser, viewer: Viewer, funding: StoredFunding): JsonObject {
  return {
    "created-date": stamp(funding.created_ms),
    "last-modified-date": stamp(funding.modified_ms),
    source: selfSource(user, viewer),
    title: titleJson(funding),
    "external-ids": idsJson(funding.external_ids, "plain"),
    url: wrap(funding.url),
    type: funding.type,
    "start-date": fuzzyDate(funding.start_date),
    "end-date": fuzzyDate(funding.end_date),
    organization: organization(funding.organization),
    visibility: funding.visibility,
    "put-code": funding.put_code,
    path: `/${user.orcid}/funding/${funding.put_code}`,
    "display-index": String(funding.display_index ?? 0),
  };
}

/**
 * `/fundings`: the visible fundings in the database's order, `displayIndex desc, dateCreated
 * asc`, grouped by external id in that order, so the groups appear in the order their first
 * member does; within a group the summaries are ordered by display index, highest first. ORCID
 * orders fundings by the query, not by the works' reverse-chronological rule, and orcid-mock
 * follows the source:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-persistence/src/main/java/org/orcid/persistence/dao/impl/ProfileFundingDaoImpl.java#L255
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/ProfileFundingManagerReadOnlyImpl.java#L115-L156
 * Each group is `{ last-modified-date, external-ids, funding-summary }`.
 */
export function fundings(user: StoredUser, viewer: Viewer): Built {
  const visible = displayOrder((user.fundings ?? []).filter((f) => canSee(viewer, f.visibility)));
  const built = groupItems(visible, (funding) => funding.external_ids, "plain").map((group) => {
    const members = byDisplayIndex(group.members);
    const lastMs = maxMs(members.map((funding) => funding.modified_ms));
    return {
      lastMs,
      json: {
        "last-modified-date": stampOrNull(lastMs),
        "external-ids": groupIdsJson(group.keys, "plain"),
        "funding-summary": members.map((funding) => summary(user, viewer, funding)),
      },
    };
  });
  const lastMs = maxMs(built.map((group) => group.lastMs));
  return {
    json: {
      "last-modified-date": stampOrNull(lastMs),
      group: built.map((group) => group.json),
      path: `/${user.orcid}/fundings`,
    },
    lastMs,
  };
}

/**
 * The full funding, seventeen keys (observed on pub.orcid.org/v3.0 on 2026-10-01): `put-code`
 * and `path` after `source`, then the type, title, and so on, `visibility` last, and no
 * `display-index`. A fixture holds no organization-defined type, short description, amount, or
 * contributors, so those are null.
 */
export function fundingItem(user: StoredUser, viewer: Viewer, putCode: number): ItemLookup {
  const funding = (user.fundings ?? []).find((candidate) => candidate.put_code === putCode);
  if (funding === undefined) return { kind: "missing" };
  if (!canSee(viewer, funding.visibility)) return { kind: "hidden" };
  return {
    kind: "ok",
    json: {
      "created-date": stamp(funding.created_ms),
      "last-modified-date": stamp(funding.modified_ms),
      source: selfSource(user, viewer),
      "put-code": funding.put_code,
      path: `/${user.orcid}/funding/${funding.put_code}`,
      type: funding.type,
      "organization-defined-type": null,
      title: titleJson(funding),
      "short-description": null,
      amount: null,
      url: wrap(funding.url),
      "start-date": fuzzyDate(funding.start_date),
      "end-date": fuzzyDate(funding.end_date),
      "external-ids": idsJson(funding.external_ids, "plain"),
      contributors: null,
      organization: organization(funding.organization),
      visibility: funding.visibility,
    },
  };
}
