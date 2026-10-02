// A Testcontainers module for orcid-mock. `startOrConnect`, which uses a running instance
// (`ORCID_MOCK_URL`) when there is one and starts a container otherwise, is re-exported from here.
//
// The mock never derives its own address from the request (its `PUBLIC_BASE_URL` fixes the issuer
// and every URL it emits), so the host port must be chosen before the container starts and the
// base URL handed to it. The port is bound explicitly, on the loopback interface only: the admin
// API has no authentication.
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import {
  AbstractStartedContainer,
  GenericContainer,
  getContainerRuntimeClient,
  ImageName,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { OrcidMockClient } from "./client.js";
import { CONTAINER_PORT, CONTAINER_USERS_PATH, resolveImage } from "./shared.js";
import { OrcidMockStartError, type UsersInput } from "./start.js";

export { OrcidMockStartError, type UsersInput } from "./start.js";

/** Attempts at picking a free port before giving up; a lost race is the only reason to retry. */
const PORT_ATTEMPTS = 3;
const READY = /"event":"listening"/;
const LOG_TAIL_LINES = 100;
const LOG_TAIL_BYTES = 16 * 1024;

/** A port the operating system says is free right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not read the port the operating system picked"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function readUsersFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OrcidMockStartError(`cannot read the users file ${path}: ${reason}`, {
      cause: error,
    });
  }
}

/** Docker's answer for a container that is already gone. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { statusCode?: number }).statusCode === 404
  );
}

function isPortConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /port is already allocated|address already in use|ports are not available/i.test(message);
}

/** An orcid-mock container that has started and answered its readiness line. */
export class StartedOrcidMockContainer extends AbstractStartedContainer {
  /** The address the mock is reachable at from the host, and its `PUBLIC_BASE_URL`. */
  readonly baseUrl: string;
  /** A client for the admin API and the headless sign-in. */
  readonly client: OrcidMockClient;

  constructor(started: StartedTestContainer, baseUrl: string) {
    super(started);
    this.baseUrl = baseUrl;
    this.client = new OrcidMockClient(baseUrl);
  }
}

/**
 * ```ts
 * const mock = await new OrcidMockContainer().withUsers("fixtures/users.json").start();
 * const token = await mock.client.signIn({ orcid: "0000-0002-1825-0097" });
 * await mock.stop();
 * ```
 *
 * The image is the constructor argument, else `ORCID_MOCK_IMAGE`, else the image that matches
 * this package's version. The Docker daemon must be on the machine that runs the tests, since the
 * base URL is `http://localhost:<port>`.
 */
export class OrcidMockContainer extends GenericContainer {
  #containerId: string | undefined;
  #logTail = "";

  constructor(image?: string) {
    super(resolveImage(image));
    this.withEnvironment({ HOST: "0.0.0.0" })
      .withWaitStrategy(Wait.forLogMessage(READY))
      .withStartupTimeout(60_000)
      // Testcontainers removes a container that never became ready, so keep its output now.
      .withLogConsumer((stream) => {
        stream.on("data", (chunk: Buffer | string) => {
          this.#logTail = (this.#logTail + chunk.toString()).slice(-LOG_TAIL_BYTES);
        });
      });
  }

  /** Replaces the image, whatever the constructor chose. */
  withImage(image: string): this {
    this.imageName = ImageName.fromString(image);
    return this;
  }

  /**
   * Serves this users file instead of the bundled starter users. The content is copied into the
   * container with mode 0644, so it works whatever the file's own permissions are (a bind mount
   * must be readable by the image's `nonroot` user) and with a remote Docker daemon.
   * A path is read now, so a missing file throws an `OrcidMockStartError` here, with its path; an
   * object is serialized now. Calling it again replaces the earlier file.
   */
  withUsers(users: UsersInput): this {
    const content = typeof users === "string" ? readUsersFile(users) : JSON.stringify(users);
    this.contentsToCopy = this.contentsToCopy.filter(
      (copy) => copy.target !== CONTAINER_USERS_PATH,
    );
    return this.withCopyContentToContainer([
      { content, target: CONTAINER_USERS_PATH, mode: 0o644 },
    ]).withEnvironment({ USERS_FILE: CONTAINER_USERS_PATH });
  }

  override async start(): Promise<StartedOrcidMockContainer> {
    for (let attempt = 1; ; attempt++) {
      const port = await this.pickPort();
      const baseUrl = `http://localhost:${port}`;
      this.#bind(port, baseUrl);
      this.#containerId = undefined;
      this.#logTail = "";
      try {
        const started = new StartedOrcidMockContainer(await super.start(), baseUrl);
        await waitUntilReachable(started.client);
        return started;
      } catch (error) {
        const { logs, problems } = await this.#discard();
        if (attempt < PORT_ATTEMPTS && isPortConflict(error)) continue;
        throw new OrcidMockStartError(
          `orcid-mock did not start from ${this.imageName.string}: ${
            error instanceof Error ? error.message : String(error)
          }${logs === "" ? "" : `\n--- container output ---\n${logs}`}${
            problems.length === 0 ? "" : `\n--- cleanup ---\n${problems.join("\n")}`
          }`,
          { cause: error },
        );
      }
    }
  }

  /**
   * A host port to publish on. The operating system's answer can be taken by the time Docker binds
   * it, which `start()` survives by asking again; a subclass can answer otherwise to prove that.
   */
  protected pickPort(): Promise<number> {
    return freePort();
  }

  protected override async containerCreated(containerId: string): Promise<void> {
    this.#containerId = containerId;
  }

  /**
   * After a failed start: the tail of the container's output, which holds the server's own message
   * (a users file it rejected, say), and the container removed. Testcontainers removes a container
   * that never became ready, but leaves one that exited before its ports were bound for its
   * reaper at the end of the process; that one is read and removed here. Touches only the
   * container this start created. Each step that fails is reported in `problems`, so a container
   * that could not be removed is never left silently.
   */
  async #discard(): Promise<{ logs: string; problems: string[] }> {
    const problems: string[] = [];
    if (this.#containerId === undefined) return { logs: this.#logTail.trim(), problems };
    let logs = this.#logTail;
    try {
      const client = await getContainerRuntimeClient();
      const container = client.container.getById(this.#containerId);
      if (logs === "") {
        try {
          const stream = await client.container.logs(container, { tail: LOG_TAIL_LINES });
          for await (const chunk of stream) logs += chunk.toString();
        } catch (error) {
          if (!isNotFound(error)) problems.push(`could not read the container's output: ${error}`);
        }
      }
      try {
        await container.remove({ force: true, v: true });
      } catch (error) {
        // Testcontainers may have removed it already; anything else leaves a container behind.
        if (!isNotFound(error)) {
          problems.push(`could not remove container ${this.#containerId.slice(0, 12)}: ${error}`);
        }
      }
    } catch (error) {
      problems.push(`could not reach the container runtime to clean up: ${error}`);
    }
    return { logs: logs.trim(), problems };
  }

  /** Publishes the container port on `port`, loopback only, and tells the mock its address. */
  #bind(port: number, baseUrl: string): void {
    const key = `${CONTAINER_PORT}/tcp`;
    this.exposedPorts = [{ container: CONTAINER_PORT, host: port }];
    this.createOpts.ExposedPorts = { [key]: {} };
    this.hostConfig.PortBindings = { [key]: [{ HostIp: "127.0.0.1", HostPort: String(port) }] };
    this.withEnvironment({ PUBLIC_BASE_URL: baseUrl });
  }
}

/** The readiness line says the server listens; this says the published port reaches it. */
async function waitUntilReachable(client: OrcidMockClient): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      await client.health();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new OrcidMockStartError(`the container is up but ${client.baseUrl} does not answer`, {
    cause: lastError,
  });
}

export { type OrcidMock, type StartOrConnectOptions, startOrConnect } from "./start.js";
