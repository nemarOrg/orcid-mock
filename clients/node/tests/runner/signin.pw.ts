// The fixtures through Playwright's own runner: one mock per worker, `signInAs` bound to it.
import { expect, test } from "../../src/playwright";
import { type RelyingParty, startRelyingParty } from "../relying-party";

let relyingParty: RelyingParty;

test.beforeAll(async ({ orcidMock }) => {
  relyingParty = await startRelyingParty(orcidMock.client);
});

test.afterAll(async () => {
  await relyingParty.stop();
});

test.beforeEach(async ({ orcidMock }) => {
  await orcidMock.client.reset();
  // reset() restores the clients of the loaded file, which drops the relying party's.
  await relyingParty.register();
});

test("signInAs completes a sign-in through the fixtures", async ({ page, orcidMock, signInAs }) => {
  test.info().annotations.push({ type: "mock", description: orcidMock.baseUrl });
  const users = await orcidMock.client.users();
  const alder = users.find((user) => user.name.given_names === "Alder");
  if (!alder) throw new Error("the starter has Alder");

  await page.goto(`${relyingParty.url}/login`);
  await signInAs(page, alder.orcid);
  await page.waitForURL(`${relyingParty.url}/callback**`);
  await expect(page.locator("#orcid")).toHaveText(alder.orcid);
  await expect(page.locator("#name")).toHaveText("A. Fennimore");
});
