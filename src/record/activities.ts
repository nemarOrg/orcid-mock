// `/activities`: the eleven activity sections in one object, and the always-empty
// `research-resources`.
import type { StoredUser } from "../store/types";
import { affiliations } from "./affiliations";
import { fundings } from "./fundings";
import { peerReviews } from "./peer-reviews";
import type { Viewer } from "./viewer";
import { type Built, maxMs, stampOrNull } from "./wire";
import { works } from "./works";

/**
 * Research resources have no section in a fixture, so the container is always empty, with the
 * `group` key (observed on a record with none).
 */
export function researchResources(user: StoredUser): Built {
  return {
    json: {
      "last-modified-date": null,
      group: [],
      path: `/${user.orcid}/research-resources`,
    },
    lastMs: null,
  };
}

/**
 * The activities summary: `last-modified-date`, then the eleven containers in ORCID's order
 * (alphabetical by key), then `path` (`/{iD}/activities`); all eleven are always present. The
 * date is the latest of the eleven sections' dates, recomputed after filtering
 * (`calculateLastModified(ActivitiesSummary)`; observed to match):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/version/impl/Api3_0LastModifiedDatesHelper.java#L41-L70
 */
export function activities(user: StoredUser, viewer: Viewer): Built {
  const distinctions = affiliations(user, viewer, "distinction");
  const educations = affiliations(user, viewer, "education");
  const employments = affiliations(user, viewer, "employment");
  const fundingsBuilt = fundings(user, viewer);
  const invitedPositions = affiliations(user, viewer, "invited-position");
  const memberships = affiliations(user, viewer, "membership");
  const reviews = peerReviews(user, viewer);
  const qualifications = affiliations(user, viewer, "qualification");
  const resources = researchResources(user);
  const services = affiliations(user, viewer, "service");
  const worksBuilt = works(user, viewer);
  const lastMs = maxMs([
    distinctions.lastMs,
    educations.lastMs,
    employments.lastMs,
    fundingsBuilt.lastMs,
    invitedPositions.lastMs,
    memberships.lastMs,
    reviews.lastMs,
    qualifications.lastMs,
    resources.lastMs,
    services.lastMs,
    worksBuilt.lastMs,
  ]);
  return {
    json: {
      "last-modified-date": stampOrNull(lastMs),
      distinctions: distinctions.json,
      educations: educations.json,
      employments: employments.json,
      fundings: fundingsBuilt.json,
      "invited-positions": invitedPositions.json,
      memberships: memberships.json,
      "peer-reviews": reviews.json,
      qualifications: qualifications.json,
      "research-resources": resources.json,
      services: services.json,
      works: worksBuilt.json,
      path: `/${user.orcid}/activities`,
    },
    lastMs,
  };
}
