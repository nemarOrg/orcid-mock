// Regenerates fixtures/users.example.json, the bundled starter next to its schema.
// `orcid-mock fixture` writes the same users but names the published schema URL instead.
import { starterFixtureJson } from "../src/fixtures/starter";

await Bun.write(
  new URL("../fixtures/users.example.json", import.meta.url),
  starterFixtureJson("./users.schema.json"),
);
