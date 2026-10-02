// The other half of isolation.pw.ts; see there.
import { expect, test } from "../../src/playwright";

test("this worker's mock is its own, too", async ({ orcidMock }) => {
  test.info().annotations.push({ type: "mock", description: orcidMock.baseUrl });
  const before = (await orcidMock.client.users()).length;
  await orcidMock.client.createUser({
    name: { given_names: "Isolation", family_name: "Two", visibility: "public" },
  });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect((await orcidMock.client.users()).length).toBe(before + 1);
});
