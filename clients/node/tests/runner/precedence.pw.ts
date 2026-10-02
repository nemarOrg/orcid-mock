// The `image` option wins over ORCID_MOCK_IMAGE. tests/runner.test.ts runs this file twice with
// ORCID_MOCK_IMAGE naming an image that does not exist: once with the real image passed as the
// option (it must start), and once without (it must fail, which proves the variable is read).
import { expect, test } from "../../src/playwright";

test.use({ orcidMockOptions: { image: process.env.RUNNER_IMAGE_OPTION } });

test("the image option decides which image starts", async ({ orcidMock }) => {
  expect((await orcidMock.client.health()).status).toBe("ok");
});
