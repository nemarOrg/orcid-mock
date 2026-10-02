// How ORCID orders the items of a section before it groups or serves them.

interface Orderable {
  display_index?: number | undefined;
  created_ms: number;
}

/**
 * The person-level lists and the fundings come from queries that end `order by displayIndex
 * desc, dateCreated asc`, so a higher display index is first and the older item breaks a tie:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-persistence/src/main/java/org/orcid/persistence/dao/impl/OtherNameDaoImpl.java#L35
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-persistence/src/main/java/org/orcid/persistence/dao/impl/ProfileFundingDaoImpl.java#L255
 * (observed on `other-names`: display indexes 3, 2, 1). A missing display index is 0.
 * orcid-mock choice: the sort is stable, so items that tie on both keep the fixture's order,
 * which ORCID leaves to the database.
 */
export function displayOrder<T extends Orderable>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => (b.display_index ?? 0) - (a.display_index ?? 0) || a.created_ms - b.created_ms,
  );
}
