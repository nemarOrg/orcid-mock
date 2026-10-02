// The socket refuses a request body above 8 MiB (MAX_REQUEST_BODY_BYTES) with a 413, so an
// unauthenticated client cannot make the process buffer and parse a huge body. Bun's default limit
// is 128 MiB.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { MAX_REQUEST_BODY_BYTES } from "../src/server";
import { startTestServer, type TestServer } from "./harness";
import { CLIENTS } from "./helpers/oauth";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
}, 10_000);
beforeEach(() => server.reset());
afterAll(() => server.stop());

const NINE_MIB = 9 * 1024 * 1024;
const MIB = 1024 * 1024;

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const JSON_BODY = { "content-type": "application/json" };

async function stillHealthy(): Promise<void> {
  const health = await server.admin<{ status: string }>("GET", "/health");
  expect(health.status).toBe(200);
  expect(health.body.status).toBe("ok");
}

describe("a body above the limit is a 413 and the server carries on", () => {
  test("the limit is 8 MiB", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(8 * MIB);
  });

  test("9 MiB to /oauth/token", async () => {
    const body = `grant_type=client_credentials&client_id=${CLIENTS.public.client_id}&padding=${"a".repeat(NINE_MIB)}`;
    const response = await fetch(`${server.baseUrl}/oauth/token`, {
      method: "POST",
      headers: FORM,
      body,
    });
    expect(response.status).toBe(413);
    await stillHealthy();
  });

  test("9 MiB to /__admin/users", async () => {
    const before = (await server.admin<unknown[]>("GET", "/users")).body.length;
    const body = JSON.stringify({ name: { given_names: "x".repeat(NINE_MIB) } });
    const response = await fetch(`${server.baseUrl}/__admin/users`, {
      method: "POST",
      headers: JSON_BODY,
      body,
    });
    expect(response.status).toBe(413);
    await stillHealthy();
    // Nothing was created.
    expect((await server.admin<unknown[]>("GET", "/users")).body).toHaveLength(before);
  });

  test("a body just under the limit is read, and the app answers it", async () => {
    const body = `grant_type=client_credentials&client_id=${CLIENTS.public.client_id}&client_secret=${CLIENTS.public.client_secret}&padding=${"a".repeat(MIB)}`;
    const response = await fetch(`${server.baseUrl}/oauth/token`, {
      method: "POST",
      headers: FORM,
      body,
    });
    expect(response.status).toBe(200);
  });
});
