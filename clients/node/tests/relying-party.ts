// The test's own OAuth client: a tiny relying party that sends the browser to the mock and
// exchanges the code it gets back, as an application under test does. It is plain `node:http`, so
// it runs under `bun test` and inside Playwright's runner alike.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OrcidMockClient } from "../src/client";

const CLIENT_ID = "APP-RELYING-PARTY";
const CLIENT_SECRET = "relying-party-secret";

export interface RelyingParty {
  /** `http://127.0.0.1:<port>`; `/login` starts a sign-in, `/slow-login` starts one after 800 ms. */
  url: string;
  /** Registers the relying party as a client of the mock; `reset()` on the mock undoes it. */
  register(): Promise<void>;
  stop(): Promise<void>;
}

const page = (body: string) => `<!doctype html><title>relying party</title>${body}`;

/**
 * Starts the relying party on a free port and registers it as a client of the mock. `/callback`
 * answers a page with the signed-in iD in `#orcid` and the name in `#name`.
 */
export async function startRelyingParty(mock: OrcidMockClient): Promise<RelyingParty> {
  let url = "";
  const redirectUri = () => `${url}/callback`;
  const authorizeUrl = (state: string) =>
    `${mock.baseUrl}/oauth/authorize?${new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      scope: "/authenticate",
      redirect_uri: redirectUri(),
      state,
    })}`;

  const server: Server = createServer(async (request, response) => {
    const requested = new URL(request.url ?? "/", url);
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": "text/html", ...headers });
      response.end(body);
    };
    try {
      if (requested.pathname === "/login") {
        send(302, "", { location: authorizeUrl("state-1") });
      } else if (requested.pathname === "/slow-login") {
        // A delayed redirect, so a test can call signInAs while the browser is still here.
        const target = JSON.stringify(authorizeUrl("state-2"));
        send(200, page(`<script>setTimeout(() => { location.href = ${target}; }, 800);</script>`));
      } else if (requested.pathname === "/callback") {
        const code = requested.searchParams.get("code");
        if (code === null) {
          send(400, page("<p>no code</p>"));
          return;
        }
        const token = await fetch(`${mock.baseUrl}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: redirectUri(),
          }),
        });
        const body = (await token.json()) as { orcid?: string; name?: string };
        if (token.status !== 200 || !body.orcid) {
          send(500, page(`<p>token exchange failed: ${JSON.stringify(body)}</p>`));
          return;
        }
        send(
          200,
          page(
            `<h1>Signed in</h1><p id="orcid">${body.orcid}</p><p id="name">${body.name ?? ""}</p>`,
          ),
        );
      } else {
        send(404, page("<p>not found</p>"));
      }
    } catch (error) {
      send(500, page(`<p>${String(error)}</p>`));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const register = async () => {
    await mock.putClient(CLIENT_ID, {
      client_secret: CLIENT_SECRET,
      name: "Relying party under test",
      redirect_uris: [redirectUri()],
    });
  };
  await register();

  return {
    url,
    register,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
