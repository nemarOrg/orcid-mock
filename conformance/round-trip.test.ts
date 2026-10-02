// The epic's definition of done, in one test: a brand-new ORCID sign-up driven from an automated
// test with no browser. It creates a user the way a sign-up would (through the admin API), signs
// that user in with the OpenID Connect authorization-code flow, verifies the ID token against the
// published key, reads the user back through userinfo and the record API, resets the mock, and
// checks that the user is gone.
//
// Mock only. Real ORCID needs a person to sign in (a browser, a password, a consent click), so
// the sandbox run covers the token endpoint and the record API and leaves sign-in to this file.
// The admin API this file drives exists only in orcid-mock.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createClient } from "./client";
import { apiError, check, recordShapes } from "./shapes";
import { loadTarget } from "./target";

setDefaultTimeout(30_000);

const target = loadTarget();
const client = createClient(target);

/** Names which step of the round trip failed; the original error stays as the cause. */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Round trip, step "${label}": ${reason}`, { cause: error });
  }
}

/** A JSON call to the admin API. */
function admin(method: string, path: string, body?: unknown) {
  return client.request(`${target.apiBase}/__admin${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

const isMock = target.name === "mock";

// The title carries the reason, since a skipped test is listed by name and nothing else.
describe.skipIf(!isMock)(
  isMock
    ? "round trip: a brand-new sign-up"
    : "round trip: a brand-new sign-up (mock only: skipped because CONFORMANCE_TARGET is not mock)",
  () => {
    test("create, sign in, verify, read, reset", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const redirectUri = "http://localhost:8080/callback";
      const clientId = `APP-ROUNDTRIP-${suffix.toUpperCase()}`;
      const clientSecret = crypto.randomUUID();
      const nonce = crypto.randomUUID();
      const state = crypto.randomUUID();
      const givenNames = "Wren";
      const familyName = `Roundtrip-${suffix}`;

      // An application under test registers its own redirect URI, then a person signs up.
      await step("register a client", async () => {
        const reply = await admin("PUT", `/clients/${clientId}`, {
          client_id: clientId,
          client_secret: clientSecret,
          name: "Round trip",
          redirect_uris: [redirectUri],
        });
        expect(reply.status).toBe(201);
      });
      const iD = await step("create a user", async () => {
        const reply = await admin("POST", "/users", {
          name: { given_names: givenNames, family_name: familyName, visibility: "public" },
          emails: [
            {
              email: `wren.${suffix}@example.test`,
              primary: true,
              verified: true,
              visibility: "private",
            },
          ],
        });
        expect(reply.status).toBe(201);
        const user = reply.json as { orcid: string };
        expect(user.orcid).toMatch(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/);
        return user.orcid;
      });

      // Sign in with no page: `login_as` skips it, and the answer is a redirect carrying the code.
      const code = await step("authorize", async () => {
        const query = new URLSearchParams({
          client_id: clientId,
          response_type: "code",
          scope: "openid",
          redirect_uri: redirectUri,
          state,
          nonce,
          login_as: iD,
        });
        const reply = await client.request(`${target.apiBase}/oauth/authorize?${query}`);
        expect(reply.status).toBe(302);
        const location = new URL(reply.headers.get("location") ?? "");
        expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
        expect(location.searchParams.get("state")).toBe(state);
        const issued = location.searchParams.get("code");
        expect(issued).toMatch(/^[0-9A-Za-z]{6}$/);
        return issued as string;
      });

      const tokens = await step("exchange the code", async () => {
        const reply = await client.tokenRequest({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        });
        expect(reply.status).toBe(200);
        const body = reply.json as {
          access_token: string;
          id_token: string;
          orcid: string;
          scope: string;
        };
        expect(body.orcid).toBe(iD);
        expect(body.scope).toBe("openid");
        expect(typeof body.id_token).toBe("string");
        return body;
      });

      await step("verify the ID token against the published key", async () => {
        const discovery = await client.request(
          `${target.apiBase}/.well-known/openid-configuration`,
        );
        expect(discovery.status).toBe(200);
        const { issuer, jwks_uri } = discovery.json as { issuer: string; jwks_uri: string };
        // The key set has no `alg` member, as ORCID's has none, so the algorithm is pinned here.
        const { payload, protectedHeader } = await jwtVerify(
          tokens.id_token,
          createRemoteJWKSet(new URL(jwks_uri)),
          {
            issuer,
            audience: clientId,
            algorithms: ["RS256"],
            requiredClaims: ["exp", "iat", "sub", "aud", "iss"],
          },
        );
        expect(protectedHeader.alg).toBe("RS256");
        expect(payload.sub).toBe(iD);
        expect(payload.nonce).toBe(nonce);
      });

      await step("read the user through userinfo", async () => {
        const reply = await client.request(`${target.apiBase}/oauth/userinfo`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        });
        expect(reply.status).toBe(200);
        const info = reply.json as { sub: string; given_name: string; family_name: string };
        expect(info.sub).toBe(iD);
        expect(info.given_name).toBe(givenNames);
        expect(info.family_name).toBe(familyName);
      });

      // A new account has a name and nothing else, so its works are an empty list.
      await step("read the record", async () => {
        const shapes = recordShapes(iD);
        const details = await client.readRecord(iD, "personal-details");
        expect(details.status).toBe(200);
        expect(check(details.json, shapes.personalDetails)).toEqual([]);
        const name = (details.json as { name: { "given-names": { value: string } } }).name;
        expect(name["given-names"].value).toBe(givenNames);

        const record = await client.readRecord(iD, "record");
        expect(record.status).toBe(200);
        expect(check(record.json, shapes.record)).toEqual([]);

        const works = await client.readRecord(iD, "works");
        expect(works.status).toBe(200);
        expect(check(works.json, shapes.works)).toEqual([]);
        expect((works.json as { group: unknown[] }).group).toEqual([]);
      });

      // One call returns the mock to the loaded file: the new user, its client, and the tokens go,
      // and the fixture's own users stay. It resets the whole mock, so run this against one you own.
      await step("reset and find the user gone", async () => {
        const reset = await admin("POST", "/reset");
        expect(reset.status).toBe(200);

        const gone = await client.readRecord(iD, "personal-details");
        expect(gone.status).toBe(404);
        expect(check(gone.json, apiError)).toEqual([]);
        expect((gone.json as { "error-code": number })["error-code"]).toBe(9016);

        const staleToken = await client.request(`${target.apiBase}/oauth/userinfo`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        });
        expect(staleToken.status).toBe(403);

        // The client this test registered is gone too, and a request that names it is refused.
        expect((await admin("GET", `/clients/${clientId}`)).status).toBe(404);
        const refused = await client.tokenRequest({
          grant_type: "client_credentials",
          scope: "/read-public",
          client_id: clientId,
          client_secret: clientSecret,
        });
        expect(refused.status).toBe(401);
        expect((refused.json as { error: string }).error).toBe("invalid_client");

        const fixtureUser = await client.readRecord(target.publicId, "personal-details");
        expect(fixtureUser.status).toBe(200);
      });
    });
  },
);
