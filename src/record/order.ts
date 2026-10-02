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

/** `[year, month, day]` of a fixture date; a missing part is undefined. */
function dateParts(date: string | null | undefined): [string, string?, string?] | null {
  if (date === null || date === undefined || date.trim() === "") return null;
  const [year, month, day] = date.split("-");
  return year === undefined || year === "" ? null : [year, month, day];
}

/**
 * The string ORCID sorts works by: `year-month-day`, with `0` for each part a date lacks and
 * `0-0-0` for no date at all; compared as plain strings, which is why a missing month sorts
 * before `02`. `PojoUtil.createDateSortString(null, publicationDate)`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/pojo/ajaxForm/PojoUtil.java#L116-L134
 */
export function workDateSortString(date: string | null | undefined): string {
  const parts = dateParts(date);
  if (parts === null) return "0-0-0";
  return `${parts[0]}-${parts[1] ?? "0"}-${parts[2] ?? "0"}`;
}

/**
 * ORCID's order of the `WorkType` enum, the last tie-break between works that share a date and a
 * title (`WORK_TYPE` in `WorkComparators` is the enum's natural order, its declaration order):
 * https://github.com/ORCID/orcid-model/blob/9592e2d3bde21a1edf703f26f8bc304448f886fb/src/main/java/org/orcid/jaxb/model/common/WorkType.java#L6-L64
 */
const WORK_TYPE_ORDER = [
  "annotation",
  "artistic-performance",
  "blog-post",
  "book-chapter",
  "book-review",
  "book",
  "cartographic-material",
  "clinical-study",
  "conference-abstract",
  "conference-output",
  "conference-paper",
  "conference-poster",
  "conference-presentation",
  "conference-proceedings",
  "data-management-plan",
  "data-set",
  "design",
  "dictionary-entry",
  "disclosure",
  "dissertation-thesis",
  "edited-book",
  "encyclopedia-entry",
  "image",
  "invention",
  "journal-article",
  "journal-issue",
  "learning-object",
  "lecture-speech",
  "license",
  "magazine-article",
  "manual",
  "moving-image",
  "musical-composition",
  "newsletter-article",
  "newspaper-article",
  "online-resource",
  "other",
  "patent",
  "physical-object",
  "preprint",
  "public-speech",
  "registered-copyright",
  "report",
  "research-technique",
  "research-tool",
  "review",
  "software",
  "sound",
  "spin-off-company",
  "standards-and-policy",
  "supervised-student-publication",
  "technical-standard",
  "test",
  "trademark",
  "transcription",
  "translation",
  "website",
  "working-paper",
  "undefined",
];

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Sortable {
  title: string;
  type: string;
  publication_date?: string | null | undefined;
}

/**
 * How two works' preferred summaries order their groups: publication date newest first (the
 * sort strings above, reversed), then title ascending, then type in enum order; groups that tie
 * on all three keep the order they were formed in (`WorkComparators.GROUP`, then
 * `ALL_EXCEPT_DISPLAY_INDEX`):
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/utils/v3/activities/WorkComparators.java#L25-L59
 * A type the enum does not list sorts after every type it does, by name.
 */
export function compareWorks(a: Sortable, b: Sortable): number {
  const byDate = -compareStrings(
    workDateSortString(a.publication_date),
    workDateSortString(b.publication_date),
  );
  if (byDate !== 0) return byDate;
  const byTitle = compareStrings(a.title, b.title);
  if (byTitle !== 0) return byTitle;
  const rank = (type: string) => {
    const index = WORK_TYPE_ORDER.indexOf(type);
    return index === -1 ? WORK_TYPE_ORDER.length : index;
  };
  return (
    rank(a.type) - rank(b.type) ||
    (rank(a.type) === WORK_TYPE_ORDER.length ? compareStrings(a.type, b.type) : 0)
  );
}

/**
 * The string ORCID sorts affiliations by, descending, before it groups them: `Z-` and the
 * creation date for an item with neither start nor end date (so undated items come first),
 * `Y-` and the start date for one with no end date (ongoing, latest start first), and `X-` and
 * the end date, then the start date, for one that has ended (latest end first). A missing month
 * or day is `00`; the creation date's month and day are not zero-padded, a quirk of the string
 * compare. `PojoUtil.createDateSortStringForAffiliations`, observed on a record whose start
 * dates 1930 and 1929 listed in that order:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/pojo/ajaxForm/PojoUtil.java#L213-L261
 */
export function affiliationSortString(item: {
  start_date?: string | null | undefined;
  end_date?: string | null | undefined;
  created_ms: number;
}): string {
  const start = dateParts(item.start_date);
  const end = dateParts(item.end_date);
  const format = (parts: [string, string?, string?]) =>
    `${parts[0]}-${parts[1] ?? "00"}-${parts[2] ?? "00"}`;
  if (end === null) {
    if (start !== null) return `Y-${format(start)}`;
    const created = new Date(item.created_ms);
    return `Z-${created.getUTCFullYear()}-${created.getUTCMonth() + 1}-${created.getUTCDate()}`;
  }
  return start === null ? `X-${format(end)}` : `X-${format(end)}-${format(start)}`;
}

/** Sorts by `affiliationSortString`, descending; items with equal strings keep their order. */
export function affiliationOrder<
  T extends {
    start_date?: string | null | undefined;
    end_date?: string | null | undefined;
    created_ms: number;
  },
>(items: readonly T[]): T[] {
  return items
    .map((item) => ({ item, key: affiliationSortString(item) }))
    .sort((a, b) => compareStrings(b.key, a.key))
    .map(({ item }) => item);
}

interface Completable {
  completion_date?: string | null | undefined;
  created_ms: number;
}

/** A completion date as year, month, day numbers, each -1 when missing (sorts lowest). */
function completionTuple(date: string | null | undefined): [number, number, number] {
  const parts = dateParts(date);
  if (parts === null) return [-1, -1, -1];
  return [
    Number(parts[0]),
    parts[1] === undefined ? -1 : Number(parts[1]),
    parts[2] === undefined ? -1 : Number(parts[2]),
  ];
}

/**
 * Peer reviews come from a query ordered `completionDate.year desc, month desc, day desc`, so the
 * latest review is first and a review with no completion date, which the database sorts lowest,
 * is last:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-persistence/src/main/java/org/orcid/persistence/dao/impl/PeerReviewDaoImpl.java#L47
 * Ties keep the fixture's order.
 */
export function peerReviewOrder<T extends Completable>(items: readonly T[]): T[] {
  return items
    .map((item) => ({ item, key: completionTuple(item.completion_date) }))
    .sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2])
    .map(({ item }) => item);
}

/**
 * Within a group the summaries are sorted by display index, highest first, and nothing else:
 * `GroupableActivityComparator` is `compareTo`, whose display-index rule is the only one. The
 * sort is stable, so items that tie keep the order they came in (ORCID's is a `HashSet`'s).
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-core/src/main/java/org/orcid/core/manager/v3/read_only/impl/AffiliationsManagerReadOnlyImpl.java#L442
 */
export function byDisplayIndex<T extends { display_index?: number | undefined }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => (b.display_index ?? 0) - (a.display_index ?? 0));
}
