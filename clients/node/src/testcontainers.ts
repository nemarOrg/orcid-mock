// A Testcontainers module for orcid-mock. `startOrConnect`, which uses a running instance
// (`ORCID_MOCK_URL`) when there is one and starts a container otherwise, is re-exported from here.
//
// The mock never derives its own address from the request (its `PUBLIC_BASE_URL` fixes the issuer
// and every URL it emits), so the host port must be chosen before the container starts and the
// base URL handed to it. The port is bound explicitly, on the loopback interface only: the admin
// API has no authentication.
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import {
  AbstractStartedContainer,
  GenericContainer,
  getContainerRuntimeClient,
  ImageName,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { OrcidMockClient } from "./client";
import { CONTAINER_PORT, CONTAINER_USERS_PATH, resolveImage } from "./shared";
import type { UsersInput } from "./start";

export type { UsersInput } from "./start";

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

async function readUsersFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read the users file ${path}`, { cause: error });
  }
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
  #users: { path: string } | { json: string } | undefined;
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
   * A path is read when `start()` runs, so a missing file fails there, with its path.
   */
  withUsers(users: UsersInput): this {
    // A path is read at start; an object is serialized now, so a later mutation is not picked up.
    this.#users = typeof users === "string" ? { path: users } : { json: JSON.stringify(users) };
    return this;
  }

  override async start(): Promise<StartedOrcidMockContainer> {
    if (this.#users !== undefined) {
      const content =
        "json" in this.#users ? this.#users.json : await readUsersFile(this.#users.path);
      this.withCopyContentToContainer([
        { content, target: CONTAINER_USERS_PATH, mode: 0o644 },
      ]).withEnvironment({ USERS_FILE: CONTAINER_USERS_PATH });
    }

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
        const logs = await this.#discard();
        if (attempt < PORT_ATTEMPTS && isPortConflict(error)) continue;
        throw new Error(
          `orcid-mock did not start from ${this.imageName.string}: ${
            error instanceof Error ? error.message : String(error)
          }${logs === "" ? "" : `\n--- container output ---\n${logs}`}`,
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
   * container this start created.
   */
  async #discard(): Promise<string> {
    if (this.#containerId === undefined) return this.#logTail.trim();
    try {
      const client = await getContainerRuntimeClient();
      const container = client.container.getById(this.#containerId);
      let output = this.#logTail;
      if (output === "") {
        const stream = await client.container.logs(container, { tail: LOG_TAIL_LINES });
        for await (const chunk of stream) output += chunk.toString();
      }
      await client.container.remove(container, { removeVolumes: true });
      return output.trim();
    } catch {
      return this.#logTail.trim();
    }
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
  throw new Error(`the container is up but ${client.baseUrl} does not answer`, {
    cause: lastError,
  });
}

export { type OrcidMock, type StartOrConnectOptions, startOrConnect } from "./start";
