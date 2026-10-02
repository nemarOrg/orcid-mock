// Run by tests/proxy.test.ts in a child process whose environment names a proxy at start-up, so
// that no proxy setting leaks into the test process (Bun reads the proxy variables once). It sends
// one request with a plain `fetch` (the control, which the proxy must capture) and then drives the
// client against the real server, and prints what happened.
import { OrcidMockClient } from "../src/client";

const server = process.env.PROBE_SERVER_URL;
if (!server) throw new Error("PROBE_SERVER_URL is not set");

const control = await fetch(`${server}/control`);
const client = new OrcidMockClient(server);
const health = await client.health();
const [alder] = await client.users();
if (!alder) throw new Error("the starter has users");
const token = await client.signIn({ orcid: alder.orcid });
console.log(
  JSON.stringify({ control: control.status, health: health.status, tokenType: token.token_type }),
);
