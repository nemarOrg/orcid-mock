// Peer reviews: the three-level grouped summaries (`/peer-reviews`) and one full review
// (`/peer-review/{put-code}`).
import type { StoredUser } from "../store/types";
import { groupIdsJson, idsJson } from "./extid";
import { groupItems } from "./groups";
import type { Json, JsonObject } from "./json";
import { compareCompletionDesc, peerReviewOrder } from "./order";
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

type StoredReview = NonNullable<StoredUser["peer_reviews"]>[number];

/**
 * A peer-review summary: fourteen keys with `visibility` before `put-code` and `path`, and
 * `display-index` a string last (observed on pub.orcid.org/v3.0 on 2026-10-01).
 */
function summary(user: StoredUser, viewer: Viewer, review: StoredReview): JsonObject {
  return {
    "created-date": stamp(review.created_ms),
    "last-modified-date": stamp(review.modified_ms),
    source: selfSource(user, viewer),
    "reviewer-role": review.reviewer_role,
    "external-ids": idsJson(review.external_ids, "normalized"),
    "review-url": wrap(review.review_url),
    "review-type": review.review_type,
    "completion-date": fuzzyDate(review.completion_date),
    "review-group-id": review.review_group_id,
    "convening-organization": organization(review.convening_organization),
    visibility: review.visibility,
    "put-code": review.put_code,
    path: `/${user.orcid}/peer-review/${review.put_code}`,
    "display-index": String(review.display_index ?? 0),
  };
}

/**
 * The outer group's one key, the review-group id written as an id of type `peer-review`: no
 * normalized value, no URL, and a null relationship (observed).
 */
function groupKey(reviewGroupId: string): JsonObject {
  return {
    "external-id-type": "peer-review",
    "external-id-value": reviewGroupId,
    "external-id-normalized": null,
    "external-id-normalized-error": null,
    "external-id-url": null,
    "external-id-relationship": null,
  };
}

/**
 * `/peer-reviews`, three levels: `group` holds the reviews of one review-group id (an exact,
 * case-sensitive match), `peer-review-group` inside it holds the reviews that share an external
 * id, and `peer-review-summary` inside that holds the summaries. The visible reviews come in the
 * database's order (see `peerReviewOrder`), which fixes the order of the outer groups and of the
 * summaries; the inner groups are then ordered newest completion date first; there is no
 * display-index ordering. Every level has a `last-modified-date`, recomputed from what survives:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/PeerReviewManagerReadOnlyImpl.java#L170-L210
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/utils/v3/activities/PeerReviewGroupGenerator.java#L17-L55
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/version/impl/Api3_0LastModifiedDatesHelper.java#L205-L230
 * ORCID orders the list by the query, not by the works' ordering rule, and orcid-mock follows the
 * source. An outer group with no visible review is gone.
 */
export function peerReviews(user: StoredUser, viewer: Viewer): Built {
  const visible = peerReviewOrder(
    (user.peer_reviews ?? []).filter((review) => canSee(viewer, review.visibility)),
  );
  // Outer groups: one per review-group id, in the order the ids first appear.
  const outer = new Map<string, StoredReview[]>();
  for (const review of visible) {
    const members = outer.get(review.review_group_id);
    if (members === undefined) outer.set(review.review_group_id, [review]);
    else members.push(review);
  }

  const groups = [...outer].map(([reviewGroupId, reviews]) => {
    const inner = groupItems(reviews, (review) => review.external_ids, "normalized")
      .sort((a, b) =>
        compareCompletionDesc(a.members[0] as StoredReview, b.members[0] as StoredReview),
      )
      .map((group) => {
        const lastMs = maxMs(group.members.map((review) => review.modified_ms));
        return {
          lastMs,
          json: {
            "last-modified-date": stampOrNull(lastMs),
            "external-ids": groupIdsJson(group.keys, "normalized"),
            "peer-review-summary": group.members.map((review) => summary(user, viewer, review)),
          } as JsonObject,
        };
      });
    const lastMs = maxMs(inner.map((group) => group.lastMs));
    return {
      lastMs,
      json: {
        "last-modified-date": stampOrNull(lastMs),
        "external-ids": { "external-id": [groupKey(reviewGroupId)] },
        "peer-review-group": inner.map((group) => group.json),
      } as JsonObject,
    };
  });
  const lastMs = maxMs(groups.map((group) => group.lastMs));
  return {
    json: {
      "last-modified-date": stampOrNull(lastMs),
      group: groups.map((group) => group.json) as Json[],
      path: `/${user.orcid}/peer-reviews`,
    },
    lastMs,
  };
}

/**
 * The full peer review, observed on pub.orcid.org/v3.0 on 2026-10-01: it names the ids
 * `review-identifiers` and the date `review-completion-date` (the summary says `external-ids`
 * and `completion-date`), carries five subject keys, and ends `visibility`, `put-code`, `path`
 * with no `display-index`. A fixture holds no subject, so those five are null.
 */
export function peerReviewItem(user: StoredUser, viewer: Viewer, putCode: number): ItemLookup {
  const review = (user.peer_reviews ?? []).find((candidate) => candidate.put_code === putCode);
  if (review === undefined) return { kind: "missing" };
  if (!canSee(viewer, review.visibility)) return { kind: "hidden" };
  return {
    kind: "ok",
    json: {
      "created-date": stamp(review.created_ms),
      "last-modified-date": stamp(review.modified_ms),
      source: selfSource(user, viewer),
      "reviewer-role": review.reviewer_role,
      "review-identifiers": idsJson(review.external_ids, "normalized"),
      "review-url": wrap(review.review_url),
      "review-type": review.review_type,
      "review-completion-date": fuzzyDate(review.completion_date),
      "review-group-id": review.review_group_id,
      "subject-external-identifier": null,
      "subject-container-name": null,
      "subject-type": null,
      "subject-name": null,
      "subject-url": null,
      "convening-organization": organization(review.convening_organization),
      visibility: review.visibility,
      "put-code": review.put_code,
      path: `/${user.orcid}/peer-review/${review.put_code}`,
    },
  };
}
