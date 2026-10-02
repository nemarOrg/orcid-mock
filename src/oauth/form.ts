// Reading a form-encoded request body, which ORCID's OAuth endpoints require.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { unsupportedMediaType } from "../errors";
import { type Checked, fail } from "./checked";

export type FormResult = Checked<{ params: URLSearchParams }>;

/**
 * The body of a POST with `Content-Type: application/x-www-form-urlencoded` (parameters such as
 * `charset` allowed); anything else, a GET included, is ORCID's 415. The token endpoint is
 * `consumes = APPLICATION_FORM_URLENCODED` in ORCID-Source orcid-web/.../OauthGenericCallsController.java;
 * the 415 for a JSON body and for a GET was observed on 2026-10-01 (research 2.1).
 */
export async function readForm(c: Context<AppEnv>): Promise<FormResult> {
  const contentType = c.req.header("content-type");
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (c.req.method !== "POST" || mediaType !== "application/x-www-form-urlencoded") {
    return fail(unsupportedMediaType(c, contentType));
  }
  return { ok: true, params: new URLSearchParams(await c.req.text()) };
}
