// `startOrConnect`: use a running orcid-mock when `ORCID_MOCK_URL` names one, and start a
// container otherwise. It lives apart from `testcontainers.ts` so that a run against a running
// instance never loads the `testcontainers` package (an optional peer dependency).
import { OrcidMockClient } from "./client";
import { urlFromEnv } from "./shared";

/** A users file: the path of one on disk, or the parsed object (`{ clients, users }`). */
export type UsersInput = string | Record<string, unknown>;

export interface StartOrConnectOptions {
  /** Image for a container; see `OrcidMockContainer`. Ignored when connecting. */
  image?: string;
  /** Users for a container. Connecting to a running instance cannot apply them, and throws. */
  users?: UsersInput;
}

/** A mock the test can use, wherever it runs. */
export interface OrcidMock {
  readonly baseUrl: string;
  readonly client: OrcidMockClient;
  /** `url` when `ORCID_MOCK_URL` pointed at a running instance, `container` when one was started. */
  readonly mode: "url" | "container";
  /** Stops a container this call started; a running instance is never stopped. */
  stop(): Promise<void>;
}

/**
 * Connects to the instance at `ORCID_MOCK_URL` when that variable is set (the GitHub Action sets
 * it), and starts a container otherwise. A running instance's users cannot be changed from here,
 * so a `users` option with `ORCID_MOCK_URL` set is an error: load the users where the instance
 * starts (the Action's `users-file` input).
 */
export async function startOrConnect(options: StartOrConnectOptions = {}): Promise<OrcidMock> {
  const url = urlFromEnv();
  if (url !== undefined) {
    if (options.users !== undefined) {
      throw new Error(
        `ORCID_MOCK_URL is set (${url}), so a running orcid-mock is used and its users cannot be set here. Load them where it starts, or unset ORCID_MOCK_URL to start a container.`,
      );
    }
    const client = new OrcidMockClient(url);
    try {
      await client.health();
    } catch (error) {
      throw new Error(`ORCID_MOCK_URL is set (${url}) but orcid-mock does not answer there`, {
        cause: error,
      });
    }
    return { baseUrl: client.baseUrl, client, mode: "url", stop: async () => {} };
  }

  const { OrcidMockContainer } = await import("./testcontainers");
  const container = new OrcidMockContainer(options.image);
  if (options.users !== undefined) container.withUsers(options.users);
  const started = await container.start();
  return {
    baseUrl: started.baseUrl,
    client: started.client,
    mode: "container",
    stop: async () => {
      await started.stop();
    },
  };
}
