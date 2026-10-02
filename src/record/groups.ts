// Grouping: how ORCID folds items that describe the same thing into one group, keyed by their
// external identifiers.
import type { FixtureExternalId } from "../fixtures/schema";
import { groupId, type IdMode, isGroupable } from "./extid";

export interface Group<T> {
  /** The group's keys: the groupable ids of its members, one per group id, first one kept. */
  keys: FixtureExternalId[];
  /** In the order the items were given. */
  members: T[];
}

interface Draft<T> {
  /** Where the group was formed, which is where it stays in the output. */
  position: number;
  keys: Map<string, FixtureExternalId>;
  members: Array<{ item: T; index: number }>;
  alive: boolean;
}

/**
 * ORCID's `ActivitiesGroupGenerator`, applied to `items` in the order given:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/utils/v3/activities/ActivitiesGroupGenerator.java#L17-L42
 * An item joins every group that shares a group key with it, and when it matches several they
 * are merged, so groups are the transitive closure of "shares a key". An item with no groupable
 * id forms a group of its own with no keys. Only groupable ids are keys (a `part-of` or
 * `funded-by` id is not, see `isGroupable`), and each group id counts once:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/utils/v3/activities/ActivitiesGroup.java#L42-L59
 * Callers pass only the items the viewer may see, so a hidden item never joins a group or adds a
 * key: ORCID groups the public items only (`groupWorks(works, true)`).
 *
 * orcid-mock choices where ORCID's order is a `HashSet`'s: a merged group stays where its
 * earliest member's group was formed, and its keys are listed in the order they were met.
 */
export function groupItems<T>(
  items: readonly T[],
  idsOf: (item: T) => readonly FixtureExternalId[] | undefined,
  mode: IdMode,
): Array<Group<T>> {
  const drafts: Array<Draft<T>> = [];
  const lookup = new Map<string, Draft<T>>();

  items.forEach((item, index) => {
    const itemKeys = new Map<string, FixtureExternalId>();
    for (const id of idsOf(item) ?? []) {
      if (!isGroupable(id)) continue;
      const key = groupId(id, mode);
      if (!itemKeys.has(key)) itemKeys.set(key, id);
    }

    const matched: Array<Draft<T>> = [];
    for (const key of itemKeys.keys()) {
      const draft = lookup.get(key);
      if (draft !== undefined && !matched.includes(draft)) matched.push(draft);
    }

    const first = matched.sort((a, b) => a.position - b.position)[0];
    if (first === undefined) {
      const draft: Draft<T> = {
        position: drafts.length,
        keys: itemKeys,
        members: [{ item, index }],
        alive: true,
      };
      drafts.push(draft);
      for (const key of itemKeys.keys()) lookup.set(key, draft);
      return;
    }

    first.members.push({ item, index });
    for (const [key, id] of itemKeys) if (!first.keys.has(key)) first.keys.set(key, id);
    for (const other of matched) {
      if (other === first) continue;
      first.members.push(...other.members);
      for (const [key, id] of other.keys) if (!first.keys.has(key)) first.keys.set(key, id);
      other.alive = false;
    }
    for (const key of first.keys.keys()) lookup.set(key, first);
  });

  return drafts
    .filter((draft) => draft.alive)
    .map((draft) => ({
      keys: [...draft.keys.values()],
      members: draft.members.sort((a, b) => a.index - b.index).map(({ item }) => item),
    }));
}
