// `signInAs` in a real browser. The relying party (tests/relying-party.ts) is the test's own
// client: its /login redirects to the mock's authorize URL and its /callback exchanges the code at
// the mock's token endpoint, the way an application under test does. The mock is a real container
// (or the instance ORCID_MOCK_URL names), and the browser is real Chromium.
//
// This runs under `bun test` with the `playwright` library; tests/runner.test.ts runs the same
// flow through Playwright's own runner and the fixtures.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type Browser, chromium } from "playwright";
import type { OrcidMockUserRecord } from "../src/client";
import { signInAs } from "../src/playwright";
import { type OrcidMock, startOrConnect } from "../src/start";
import { type RelyingParty, startRelyingParty } from "./relying-party";

setDefaultTimeout(120_000);

let mock: OrcidMock;
let browser: Browser;
let relyingParty: RelyingParty;
let users: OrcidMockUserRecord[];

beforeAll(async () => {
  mock = await startOrConnect();
  await mock.client.reset();
  users = await mock.client.users();
  relyingParty = await startRelyingParty(mock.client);
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await relyingParty?.stop();
  await mock?.stop();
});

const named = (given: string) => {
  const user = users.find((candidate) => candidate.name.given_names === given);
  if (!user) throw new Error(`the starter has no user named ${given}`);
  return user;
};

describe("signInAs", () => {
  test("completes the sign-in, and the application shows the signed-in iD", async () => {
    const alder = named("Alder");
    const page = await browser.newPage();
    try {
      await page.goto(`${relyingParty.url}/login`);
      await signInAs(page, alder.orcid, { baseUrl: mock.baseUrl });
      await page.waitForURL(`${relyingParty.url}/callback**`);
      expect(await page.locator("#orcid").textContent()).toBe(alder.orcid);
      expect(await page.locator("#name").textContent()).toBe("A. Fennimore");
    } finally {
      await page.close();
    }
  });

  test("picks the button of the iD it is given, not the first one", async () => {
    const sennet = named("Sennet");
    const page = await browser.newPage();
    try {
      await page.goto(`${relyingParty.url}/login`);
      await signInAs(page, sennet.orcid, { baseUrl: mock.baseUrl });
      await page.waitForURL(`${relyingParty.url}/callback**`);
      expect(await page.locator("#orcid").textContent()).toBe(sennet.orcid);
    } finally {
      await page.close();
    }
  });

  test("waits until the browser reaches the consent page", async () => {
    const alder = named("Alder");
    const page = await browser.newPage();
    try {
      await page.goto(`${relyingParty.url}/slow-login`);
      // The page is still the application's; the redirect comes 800 ms from now.
      expect(page.url()).toStartWith(relyingParty.url);
      await signInAs(page, alder.orcid, { baseUrl: mock.baseUrl });
      await page.waitForURL(`${relyingParty.url}/callback**`);
      expect(await page.locator("#orcid").textContent()).toBe(alder.orcid);
    } finally {
      await page.close();
    }
  });

  test("a user the mock refuses to sign in is an error carrying the mock's answer", async () => {
    const locked = users.find((user) => user.locked === true);
    if (!locked) throw new Error("the starter has a locked user");
    const page = await browser.newPage();
    try {
      await page.goto(`${relyingParty.url}/login`);
      const failure = await signInAs(page, locked.orcid, { baseUrl: mock.baseUrl }).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.message).toContain(`refused the sign-in as ${locked.orcid}`);
      expect(failure?.message).toContain("400");
    } finally {
      await page.close();
    }
  });

  test("an iD with no button times out instead of signing in as someone else", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${relyingParty.url}/login`);
      const failure = await signInAs(page, "0000-0002-1825-0097", {
        baseUrl: mock.baseUrl,
        timeoutMs: 1_500,
      }).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure).not.toBeNull();
      expect(page.url()).toStartWith(`${mock.baseUrl}/oauth/authorize`);
    } finally {
      await page.close();
    }
  });
});
