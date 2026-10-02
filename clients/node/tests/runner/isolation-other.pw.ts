// Two spec files run in two workers, and each worker gets its own mock: a user created here is
// not seen by the other file's mock. tests/runner.test.ts reads the JSON report to check that the
// two ran on different workers and different mocks (a mock shared between workers would show up
// there as one URL for two workers); neither file resets, so nothing here hides a shared mock.
import { expect, test } from "../../src/playwright";

test("this worker's mock is its own, too", async ({ orcidMock }) => {
  test.info().annotations.push({ type: "mock", description: orcidMock.baseUrl });
  const before = (await orcidMock.client.users()).length;
  await orcidMock.client.createUser({
    name: { given_names: "Isolation", family_name: "Two", visibility: "public" },
  });
  expect((await orcidMock.client.users()).length).toBe(before + 1);
});
