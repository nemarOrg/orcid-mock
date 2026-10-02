// Dates that differ from item to item. A fixture stamps everything it loads with one time, and the
// admin API does the same for a whole user, so over HTTP every date in a record is equal and a date
// that leaked from a hidden item, or came from the wrong item, would look right. These tests call
// the section builders on stored users whose items carry different stamps, built by the real
// loader and then edited, and check which stamp each container, group, and history reports.
import { describe, expect, test } from "bun:test";
import { parseUsersFile } from "../src/fixtures/load";
import { affiliations } from "../src/record/affiliations";
import { fundings } from "../src/record/fundings";
import { peerReviews } from "../src/record/peer-reviews";
import {
  biography,
  emails,
  keywords,
  name,
  otherNames,
  person,
  personalDetails,
} from "../src/record/person";
import { history } from "../src/record/record";
import type { Viewer } from "../src/record/viewer";
import { works } from "../src/record/works";
import type { StoredUser } from "../src/store/types";
import { IDS, RECORD_USERS_FILE } from "./fixtures/record";

const BASE = "http://orcid-mock.test";
const PUBLIC: Viewer = { level: "public", baseUrl: BASE };
const LIMITED: Viewer = { level: "limited", baseUrl: BASE };

/** A fresh copy of a fixture user as the loader stores it, every stamp 1000. */
function load(orcid: string): StoredUser {
  const loaded = parseUsersFile(RECORD_USERS_FILE, 1000);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const user = loaded.snapshot.users.find((candidate) => candidate.orcid === orcid);
  if (user === undefined) throw new Error(`no fixture user ${orcid}`);
  return structuredClone(user);
}

const dateOf = (json: unknown): unknown => (json as Record<string, unknown>)["last-modified-date"];

/** Edits one item of a list by put-code. */
function edit<T extends { put_code: number }>(
  list: T[] | undefined,
  putCode: number,
  change: (item: T) => void,
): void {
  const item = list?.find((candidate) => candidate.put_code === putCode);
  if (item === undefined) throw new Error(`no item ${putCode}`);
  change(item);
}

describe("a container's date is the latest of the items that survive filtering", () => {
  test("emails: a newer hidden email does not leak", () => {
    const user = load(IDS.rich);
    const [pub, limited, hidden] = user.emails ?? [];
    if (!pub || !limited || !hidden) throw new Error("fixture changed");
    pub.modified_ms = 5000;
    limited.modified_ms = 9000;
    hidden.modified_ms = 12000;
    expect(emails(user, PUBLIC).lastMs).toBe(5000);
    expect(dateOf(emails(user, PUBLIC).json)).toEqual({ value: 5000 });
    expect(dateOf(emails(user, LIMITED).json)).toEqual({ value: 9000 });
  });

  test("a section whose items are all hidden has a null date, however new they are", () => {
    const user = load(IDS.allPrivate);
    edit(user.keywords, 4003, (item) => {
      item.modified_ms = 99999;
    });
    expect(dateOf(keywords.container(user, PUBLIC).json)).toBeNull();
    expect(dateOf(keywords.container(user, LIMITED).json)).toBeNull();
  });

  test("person: the six containers' dates only, never the name's or the biography's", () => {
    const user = load(IDS.rich);
    user.name.modified_ms = 99999;
    if (user.biography) user.biography.modified_ms = 88888;
    edit(user.other_names, 1001, (item) => {
      item.modified_ms = 3000;
    });
    edit(user.keywords, 1201, (item) => {
      item.modified_ms = 4000;
    });
    edit(user.addresses, 1101, (item) => {
      item.modified_ms = 2000;
    });
    // Newer, but hidden from the public.
    edit(user.researcher_urls, 1402, (item) => {
      item.modified_ms = 70000;
    });
    expect(dateOf(person(user, PUBLIC).json)).toEqual({ value: 4000 });
    // The limited reader sees the newer researcher URL.
    expect(dateOf(person(user, LIMITED).json)).toEqual({ value: 70000 });
  });

  test("personal-details: the latest of the name, the biography, and the other names that survive", () => {
    const user = load(IDS.rich);
    user.name.modified_ms = 6000;
    if (user.biography) user.biography.modified_ms = 5000;
    edit(user.other_names, 1001, (item) => {
      item.modified_ms = 4000;
    });
    expect(dateOf(personalDetails(user, PUBLIC).json)).toEqual({ value: 6000 });
    // A name the viewer may not see no longer counts.
    user.name.visibility = "private";
    expect(name(user, PUBLIC)).toBeNull();
    expect(dateOf(personalDetails(user, PUBLIC).json)).toEqual({ value: 5000 });
    if (user.biography) user.biography.visibility = "private";
    expect(biography(user, PUBLIC).state).toBe("hidden");
    expect(dateOf(personalDetails(user, PUBLIC).json)).toEqual({ value: 4000 });
  });
});

describe("a group's date is the latest of its summaries, and the container's the latest of its groups", () => {
  test("works", () => {
    const user = load(IDS.grouping);
    edit(user.works, 3201, (item) => {
      item.modified_ms = 2000;
    });
    edit(user.works, 3202, (item) => {
      item.modified_ms = 7000;
    });
    edit(user.works, 3203, (item) => {
      item.modified_ms = 3000;
    });
    // A hidden twin, newer than anything, in a group of its own and in another's.
    edit(user.works, 3214, (item) => {
      item.modified_ms = 50000;
    });
    edit(user.works, 3211, (item) => {
      item.modified_ms = 60000;
    });
    const built = works(user, PUBLIC);
    const groups = (built.json as { group: Array<Record<string, unknown>> }).group;
    expect(dateOf(groups[0])).toEqual({ value: 7000 });
    expect(built.lastMs).toBe(7000);
    expect(dateOf(built.json)).toEqual({ value: 7000 });
    // Group 3213, which has a hidden twin 3214 modified at 50000: the date stays the stamp 1000.
    const theta = groups.find(
      (g) =>
        ((g["work-summary"] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[
          "put-code"
        ] === 3213,
    );
    expect(dateOf(theta)).toEqual({ value: 1000 });
  });

  test("peer reviews have a date at all three levels", () => {
    const user = load(IDS.grouping);
    edit(user.peer_reviews, 3401, (item) => {
      item.modified_ms = 2000;
    });
    edit(user.peer_reviews, 3402, (item) => {
      item.modified_ms = 5000;
    });
    edit(user.peer_reviews, 3403, (item) => {
      item.modified_ms = 3000;
    });
    edit(user.peer_reviews, 3406, (item) => {
      item.modified_ms = 90000;
    });
    const built = peerReviews(user, PUBLIC);
    type Inner = Record<string, unknown>;
    const outer = (built.json as { group: Array<{ "peer-review-group": Inner[] } & Inner> }).group;
    // issn:1111-1111 holds 3401+3402 (dates 2000, 5000), 3409 (the stamp 1000), and 3403 (3000),
    // fourth in the database's order.
    const group1111 = outer[3];
    expect(group1111).toBeDefined();
    expect(dateOf(group1111)).toEqual({ value: 5000 });
    expect(group1111?.["peer-review-group"].map(dateOf)).toEqual([
      { value: 5000 },
      { value: 1000 },
      { value: 3000 },
    ]);
    expect(dateOf(built.json)).toEqual({ value: 5000 });
    // The hidden 3406 (90000) is in no visible group.
    expect(JSON.stringify(built.json)).not.toContain("90000");
  });

  test("affiliations and fundings", () => {
    const user = load(IDS.grouping);
    edit(user.employments, 3101, (item) => {
      item.modified_ms = 2000;
    });
    edit(user.employments, 3102, (item) => {
      item.modified_ms = 6000;
    });
    edit(user.employments, 3107, (item) => {
      item.modified_ms = 80000;
    });
    const jobs = affiliations(user, PUBLIC, "employment");
    expect(jobs.lastMs).toBe(6000);
    const merged = (jobs.json as { "affiliation-group": Array<Record<string, unknown>> })[
      "affiliation-group"
    ][3];
    expect(dateOf(merged)).toEqual({ value: 6000 });

    edit(user.fundings, 3301, (item) => {
      item.modified_ms = 4000;
    });
    edit(user.fundings, 3305, (item) => {
      item.modified_ms = 70000;
    });
    expect(fundings(user, PUBLIC).lastMs).toBe(4000);
  });
});

describe("ordering by dates that differ", () => {
  test("person-level items with the same display index: the older one first", () => {
    const user = load(IDS.carberry);
    // 5001, 5002, and 5003 have display indexes 3, 2, 1; give them all the same one.
    for (const [put, created] of [
      [5001, 300],
      [5002, 100],
      [5003, 200],
    ] as const) {
      edit(user.other_names, put, (item) => {
        item.display_index = 1;
        item.created_ms = created;
      });
    }
    const list = (
      otherNames.container(user, PUBLIC).json as { "other-name": Array<{ "put-code": number }> }
    )["other-name"];
    expect(list.map((item) => item["put-code"])).toEqual([5002, 5003, 5001]);
  });

  test("within a work group, equal display indexes: the older work is the preferred summary", () => {
    const user = load(IDS.grouping);
    edit(user.works, 3201, (item) => {
      item.display_index = 0;
      item.created_ms = 900;
    });
    edit(user.works, 3202, (item) => {
      item.display_index = 0;
      item.created_ms = 100;
    });
    const group = (
      works(user, PUBLIC).json as {
        group: Array<{ "work-summary": Array<{ "put-code": number }> }>;
      }
    ).group[0];
    expect(group?.["work-summary"].map((summary) => summary["put-code"])).toEqual([3202, 3201]);
  });

  test("undated affiliations sort by creation date as an unpadded string, a quirk ORCID has", () => {
    const user = load(IDS.grouping);
    // Both undated: 3103 created 2 October 2026 ("Z-2026-10-2"), 3108 created 30 September 2026
    // ("Z-2026-9-30"). As strings "9" sorts above "1", so the September one is first although
    // it is older.
    edit(user.employments, 3103, (item) => {
      item.created_ms = Date.UTC(2026, 9, 2);
    });
    edit(user.employments, 3108, (item) => {
      item.created_ms = Date.UTC(2026, 8, 30);
    });
    const groups = (
      affiliations(user, PUBLIC, "employment").json as {
        "affiliation-group": Array<{
          summaries: Array<{ "employment-summary": { "put-code": number } }>;
        }>;
      }
    )["affiliation-group"];
    const order = groups.map((group) => group.summaries[0]?.["employment-summary"]["put-code"]);
    expect(order.slice(0, 2)).toEqual([3108, 3103]);
  });
});

describe("history counts everything, hidden items included", () => {
  test("last-modified-date is the latest modification anywhere in the record", () => {
    const user = load(IDS.allPrivate);
    edit(user.works, 4401, (item) => {
      item.modified_ms = 77777;
    });
    expect(history(user)["last-modified-date"]).toEqual({ value: 77777 });
    // A name edited later still wins.
    user.name.modified_ms = 88888;
    expect(history(user)["last-modified-date"]).toEqual({ value: 88888 });
  });
});
