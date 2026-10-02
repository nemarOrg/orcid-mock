// A type-level check, not a test: the server's own fixture types must stay assignable to the
// helper's minimal copies, so a change to the users-file schema that the helper's types miss fails
// `bun run typecheck`. The server package does not export its types, hence the relative import.
import type { FixtureClient, FixtureUser } from "../../../src/fixtures/schema";
import type { OrcidMockClientRegistration, OrcidMockUser } from "../src/client";

export const userIsAccepted = (user: FixtureUser): OrcidMockUser => user;
export const clientIsAccepted = (client: FixtureClient): OrcidMockClientRegistration => client;
