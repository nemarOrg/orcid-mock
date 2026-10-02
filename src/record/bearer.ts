// The record API's reading of the bearer token: the `Authorization` header first, then the
// `access_token` query parameter, as ORCID's bearer filter does, judged by the one rule in
// src/oauth/bearer.ts.
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { type BearerResult, checkAccessToken, readBearerHeader } from "../oauth/bearer";
import type { Store } from "../store/types";

/**
 * The token the request presents: the header's `Bearer` value, else the `access_token` query
 * parameter; a blank value is no token at all, and the request goes on as an anonymous one:
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/common/security/oauth/OrcidBearerTokenFilter.java#L65-L69
 * https://github.com/ORCID/ORCID-Source/blob/b34bb7b5d1e4eb7ac9f63a54a2094d6b37775a5c/orcid-api-common/src/main/java/org/orcid/api/common/security/oauth/OrcidBearerTokenFilter.java#L236-L250
 */
export async function resolveRecordBearer(c: Context<AppEnv>, store: Store): Promise<BearerResult> {
  const presented = readBearerHeader(c) ?? c.req.query("access_token") ?? null;
  if (presented === null || presented.trim() === "") return { kind: "none" };
  return checkAccessToken(store, presented);
}
