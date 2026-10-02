// A Playwright fixture set for orcid-mock: `orcidMock` (one mock per worker) and `signInAs`.
//
//   import { expect, test } from "@nemarorg/orcid-mock-testing/playwright";
//   test("signs in", async ({ page, orcidMock, signInAs }) => {
//     const [alder] = await orcidMock.client.users();
//     await page.goto("/login");               // redirects to the mock's sign-in page
//     await signInAs(page, alder.orcid);       // clicks that user's button
//   });
import { test as base, expect, type Page } from "@playwright/test";
import { type OrcidMock, type StartOrConnectOptions, startOrConnect } from "./start.js";

export type { OrcidMock, StartOrConnectOptions };
export { expect };

export interface SignInAsOptions {
  /**
   * Where the consent page is expected, as `<baseUrl>/oauth/authorize`: the address the browser
   * reaches the mock at, and the address the mock puts in its own URLs (its `PUBLIC_BASE_URL`),
   * which is where the sign-in form posts. They are the same for a container, and can differ for
   * a running instance, so pass both then. Only the origin and the path are compared.
   */
  baseUrl: string | readonly string[];
  /** How long to wait for the consent page and for the mock to answer. Default 30 seconds. */
  timeoutMs?: number;
}

/**
 * Waits until `page` is on the mock's consent page, then clicks the button of the user with this
 * iD (its accessible name is "Given Family (iD)", matched as a substring). Returns once the mock
 * has answered the click; a refusal (a locked or deactivated user) throws with the mock's answer.
 * The redirect back to the application is left for the test's next assertion to wait for.
 *
 * When the application signs in in a popup, pass the popup, not the opener:
 * `const popup = await page.waitForEvent("popup"); await signInAs(popup, iD, { baseUrl });`
 */
export async function signInAs(page: Page, orcid: string, options: SignInAsOptions): Promise<void> {
  const timeout = options.timeoutMs ?? 30_000;
  const consentPages = [options.baseUrl].flat().map((address) => {
    const base = new URL(address);
    return { origin: base.origin, path: `${base.pathname.replace(/\/+$/, "")}/oauth/authorize` };
  });
  const onConsentPage = (url: URL) =>
    consentPages.some((page) => url.origin === page.origin && url.pathname === page.path);
  await page.waitForURL(onConsentPage, { timeout });

  // Listen before clicking so the answer cannot be missed; Promise.all keeps the loser of a
  // timeout race from becoming an unhandled rejection.
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" && onConsentPage(new URL(candidate.url())),
      { timeout },
    ),
    page.getByRole("button", { name: orcid }).click({ timeout }),
  ]);
  if (response.status() >= 400) {
    throw new Error(
      `orcid-mock refused the sign-in as ${orcid}: ${response.status()} ${await response.text()}`,
    );
  }
}

type WorkerFixtures = {
  /** Image and users for the container; ignored when `ORCID_MOCK_URL` names a running instance. */
  orcidMockOptions: StartOrConnectOptions;
  /**
   * The mock for this worker: a running instance (`ORCID_MOCK_URL`) or a container it started.
   * Workers do not share a container, but they do share a running instance: in that mode every
   * worker talks to the same mock and its state, so set `workers: 1` (or give each worker its own
   * users, which a running instance cannot do) and call `orcidMock.client.reset()` between tests.
   */
  orcidMock: OrcidMock;
};

type TestFixtures = {
  /** `signInAs` bound to this worker's mock. */
  signInAs: (page: Page, orcid: string) => Promise<void>;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  orcidMockOptions: [{}, { scope: "worker", option: true }],
  orcidMock: [
    async ({ orcidMockOptions }, use) => {
      const mock = await startOrConnect(orcidMockOptions);
      try {
        await use(mock);
      } finally {
        await mock.stop();
      }
    },
    // Pulling an image and starting a container can take longer than a test's default timeout.
    { scope: "worker", timeout: 120_000 },
  ],
  signInAs: async ({ orcidMock }, use) => {
    await use(async (page, orcid) =>
      signInAs(page, orcid, { baseUrl: [orcidMock.baseUrl, await orcidMock.publicBaseUrl()] }),
    );
  },
});
