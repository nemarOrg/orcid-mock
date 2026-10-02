// A Playwright fixture set for orcid-mock: `orcidMock` (one mock per worker) and `signInAs`.
//
//   import { expect, test } from "@nemarorg/orcid-mock-testing/playwright";
//   test("signs in", async ({ page, orcidMock, signInAs }) => {
//     const [alder] = await orcidMock.client.users();
//     await page.goto("/login");               // redirects to the mock's sign-in page
//     await signInAs(page, alder.orcid);       // clicks that user's button
//   });
import { test as base, expect, type Page } from "@playwright/test";
import { type OrcidMock, type StartOrConnectOptions, startOrConnect } from "./start";

export type { OrcidMock, StartOrConnectOptions };
export { expect };

export interface SignInAsOptions {
  /** The mock's base URL: where the consent page is expected (`<baseUrl>/oauth/authorize`). */
  baseUrl: string;
  /** How long to wait for the consent page and for the mock to answer. Default 30 seconds. */
  timeoutMs?: number;
}

/**
 * Waits until `page` is on the mock's consent page, then clicks the button of the user with this
 * iD (its accessible name is "Given Family (iD)", matched as a substring). Returns once the mock
 * has answered the click; a refusal (a locked or deactivated user) throws with the mock's answer.
 * The redirect back to the application is left for the test's next assertion to wait for.
 */
export async function signInAs(page: Page, orcid: string, options: SignInAsOptions): Promise<void> {
  const timeout = options.timeoutMs ?? 30_000;
  const consent = `${options.baseUrl.replace(/\/+$/, "")}/oauth/authorize`;
  await page.waitForURL((url) => url.href.startsWith(consent), { timeout });

  // Listen before clicking so the answer cannot be missed; Promise.all keeps the loser of a
  // timeout race from becoming an unhandled rejection.
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) => candidate.request().method() === "POST" && candidate.url().startsWith(consent),
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
  /** The mock for this worker: a running instance (`ORCID_MOCK_URL`) or a container it started. */
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
    await use((page, orcid) => signInAs(page, orcid, { baseUrl: orcidMock.baseUrl }));
  },
});
