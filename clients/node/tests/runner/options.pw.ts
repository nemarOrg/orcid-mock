// The `orcidMockOptions` fixture option: this file's workers serve their own users.
import { expect, test } from "../../src/playwright";

test.use({
  orcidMockOptions: {
    users: {
      clients: [],
      users: [
        {
          orcid: "0000-0002-1825-0097",
          name: { given_names: "Josiah", family_name: "Carberry", visibility: "public" },
        },
      ],
    },
  },
});

test("a users option reaches the container", async ({ orcidMock }) => {
  test.info().annotations.push({ type: "mock", description: orcidMock.baseUrl });
  const users = await orcidMock.client.users();
  expect(users.map((user) => user.orcid)).toEqual(["0000-0002-1825-0097"]);
});
