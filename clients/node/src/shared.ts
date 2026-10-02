// What every helper agrees on: which image to run and when to use a running instance instead.
// Internal; the package's exports map does not list this file.
import pkg from "../package.json" with { type: "json" };

/** The image repository without a tag. */
export const IMAGE_REPOSITORY = "ghcr.io/nemarorg/orcid-mock";

/** The port the mock listens on inside the container, fixed by the image. */
export const CONTAINER_PORT = 9700;

/** Where a users file lands inside the container. */
export const CONTAINER_USERS_PATH = "/fixtures/users.json";

/**
 * The image that matches this package: helpers are released in lockstep with the server, so the
 * helper's own version is the image tag.
 */
export function defaultImage(): string {
  return `${IMAGE_REPOSITORY}:${pkg.version}`;
}

/** An explicit option wins over `ORCID_MOCK_IMAGE`, which wins over the default. */
export function resolveImage(option?: string): string {
  if (option !== undefined && option !== "") return option;
  const fromEnv = process.env.ORCID_MOCK_IMAGE;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : defaultImage();
}

/**
 * The address of a running instance from `ORCID_MOCK_URL` (the GitHub Action sets it), or
 * undefined when the variable is unset or empty.
 */
export function urlFromEnv(): string | undefined {
  const url = process.env.ORCID_MOCK_URL;
  return url === undefined || url === "" ? undefined : url;
}
