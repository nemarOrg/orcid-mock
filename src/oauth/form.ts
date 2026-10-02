// Reading a form-encoded request body, which ORCID's OAuth endpoints require.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { unsupportedMediaType } from "../errors";
import { type Checked, fail } from "./checked";

export type FormResult = Checked<{ params: URLSearchParams }>;

/**
 * The body of a POST with `Content-Type: application/x-www-form-urlencoded` (parameters such as
 * `charset` allowed); anything else, a GET included, is ORCID's 415. The token endpoint is
 * `consumes = APPLICATION_FORM_URLENCODED`:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-web/src/main/java/org/orcid/frontend/web/controllers/OauthGenericCallsController.java#L42
 * and the 415 for a JSON body and for a GET was observed on sandbox.orcid.org on 2026-10-01.
 */
export async function readForm(c: Context<AppEnv>): Promise<FormResult> {
  const contentType = c.req.header("content-type");
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (c.req.method !== "POST" || mediaType !== "application/x-www-form-urlencoded") {
    return fail(unsupportedMediaType(c, contentType));
  }
  return { ok: true, params: new URLSearchParams(await c.req.text()) };
}
