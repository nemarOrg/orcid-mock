#!/usr/bin/env bun
// The command line: `serve` (the default), `id`, `fixture`, `schema`, and `health`.
// argv parsing lives here and nowhere else; resolveConfig only ever sees parsed flags.
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { ConfigError, type ConfigFlags, resolveConfig } from "./config";
import { FixtureError } from "./fixtures/load";
import { usersFileJsonSchemaText } from "./fixtures/schema";
import { starterFixtureJson } from "./fixtures/starter";
import { mintOrcidId } from "./orcid-id";
import { startServer } from "./server";

const USAGE = `orcid-mock ${pkg.version}: an ephemeral mock of the ORCID OAuth, OpenID Connect, and public record API

Usage: orcid-mock [serve] [options]      start the server (the default command)
       orcid-mock id [-n N]              print N freshly minted ORCID iDs
       orcid-mock fixture [--out FILE]   write the starter users file
       orcid-mock schema [--out FILE]    write the users-file JSON Schema
       orcid-mock health [--url URL]     exit 0 when the server at URL is healthy

serve options (each overrides its environment variable):
  --base-url URL    PUBLIC_BASE_URL  absolute http(s) URL the mock puts in every URL it emits
  --port N          PORT             default 9700; 0 picks a free port
  --host HOST       HOST             default 127.0.0.1
  --users FILE      USERS_FILE       default: the bundled starter
  --log-level LVL   LOG_LEVEL        debug, info, warn, or error; default info

  -h, --help        show this help
  -v, --version     print the version
`;

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

async function serve(flags: ConfigFlags): Promise<void> {
  const { core, server: serverConfig } = resolveConfig(process.env, flags);
  const server = await startServer({
    port: serverConfig.port,
    host: serverConfig.host,
    usersFile: serverConfig.usersFile,
    publicBaseUrl: core.publicBaseUrl,
    logLevel: core.logLevel,
  });
  // The readiness line is the only thing on stdout; logs go to stderr.
  console.log(JSON.stringify({ event: "listening", url: server.url, port: server.port }));

  const shutdown = async (): Promise<void> => {
    await server.stop();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

function printIds(count: number): void {
  const seen = new Set<string>();
  while (seen.size < count) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const seed = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    seen.add(mintOrcidId(seed));
  }
  console.log([...seen].join("\n"));
}

async function writeOrPrint(text: string, out: string | undefined): Promise<void> {
  if (out === undefined) process.stdout.write(text);
  else await Bun.write(out, text);
}

async function health(url: string): Promise<void> {
  let status: number;
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/__admin/health`, {
      signal: AbortSignal.timeout(3000),
    });
    status = response.status;
  } catch (error) {
    return fail(
      `health: cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  if (status !== 200) fail(`health: ${url} answered ${status}`, 1);
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(Bun.argv.slice(2));
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}\nRun orcid-mock --help for usage.`,
    );
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.version) {
    console.log(pkg.version);
    return;
  }

  const command = positionals[0] ?? "serve";
  if (positionals.length > 1) fail(`unexpected argument ${JSON.stringify(positionals[1])}`);
  const flags: ConfigFlags = {};
  for (const name of ["base-url", "port", "host", "users", "log-level"] as const) {
    const value = values[name];
    if (value !== undefined) flags[name] = value;
  }

  switch (command) {
    case "serve":
      return serve(flags);
    case "id": {
      const count = values.n === undefined ? 1 : Number(values.n);
      if (!Number.isInteger(count) || count < 1 || count > 10_000) {
        fail("-n must be an integer from 1 to 10000");
      }
      return printIds(count);
    }
    case "fixture":
      return writeOrPrint(starterFixtureJson(), values.out);
    case "schema":
      return writeOrPrint(usersFileJsonSchemaText(), values.out);
    case "health":
      return health(values.url ?? "http://127.0.0.1:9700");
    default:
      fail(`unknown command ${JSON.stringify(command)}\nRun orcid-mock --help for usage.`);
  }
}

function parseCli(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      "base-url": { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      users: { type: "string" },
      "log-level": { type: "string" },
      out: { type: "string" },
      url: { type: "string" },
      n: { type: "string", short: "n" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) fail(error.message);
  if (error instanceof FixtureError) fail(error.message);
  fail(error instanceof Error ? error.message : String(error), 1);
});
