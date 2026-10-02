// Two spec files run in two workers at once, and each worker gets its own mock: a user created
// here is invisible to the other file, and neither file resets (reset would hide a shared mock).
import { expect, test } from "../../src/playwright";

test("this worker's mock is its own", async ({ orcidMock }) => {
  test.info().annotations.push({ type: "mock", description: orcidMock.baseUrl });
  const before = (await orcidMock.client.users()).length;
  await orcidMock.client.createUser({
    name: { given_names: "Isolation", family_name: "One", visibility: "public" },
  });
  // Let the other worker write too before looking.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect((await orcidMock.client.users()).length).toBe(before + 1);
});
