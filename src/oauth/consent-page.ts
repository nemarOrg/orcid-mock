// The sign-in and consent page GET /oauth/authorize renders when no `login_as` skips it.
// Real ORCID serves a single-page app here; this is orcid-mock's own minimal replacement:
// no script and no external asset, so it renders offline and under a strict
// Content-Security-Policy, and every interpolated value is escaped.
import { escapeHtml } from "../html";
import type { ScopeName, StoredClient, StoredUser } from "../store/types";

const SCOPE_MEANING: Record<ScopeName, string> = {
  "/authenticate": "Know your ORCID iD",
  openid: "Sign you in with OpenID Connect",
  "/read-limited": "Read the information on your record that you share with trusted parties",
  "/read-public": "Read public information",
};

export interface ConsentPage {
  /** Absolute URL of POST /oauth/authorize, built from the public base URL. */
  action: string;
  client: StoredClient;
  scopes: readonly ScopeName[];
  users: readonly StoredUser[];
  /** Every parameter of the original request; each is carried through the form as a hidden field. */
  params: URLSearchParams;
}

/** The names the form fields of this page use; a request parameter of the same name is dropped. */
const RESERVED_FIELDS = new Set(["orcid", "action"]);

function hiddenFields(params: URLSearchParams, indent: string): string {
  const fields: string[] = [];
  for (const [name, value] of params) {
    if (RESERVED_FIELDS.has(name)) continue;
    fields.push(
      `${indent}<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    );
  }
  return fields.join("\n");
}

/** "Given Family (iD)", the family name left out when the user has none. */
function userLabel(user: StoredUser): string {
  const family = user.name.family_name?.trim();
  const names = family ? `${user.name.given_names} ${family}` : user.name.given_names;
  return `${names} (${user.orcid})`;
}

function standing(user: StoredUser): string {
  if (user.deactivated) return " (deactivated: sign-in is refused)";
  if (user.locked) return " (locked: sign-in is refused)";
  return "";
}

export function renderConsentPage(page: ConsentPage): string {
  const action = escapeHtml(page.action);
  const scopes = page.scopes
    .map(
      (scope) =>
        `    <li><code>${escapeHtml(scope)}</code>: ${escapeHtml(SCOPE_MEANING[scope])}</li>`,
    )
    .join("\n");
  const users =
    page.users.length === 0
      ? "  <p>No users are defined. Add one with <code>POST /__admin/users</code>.</p>"
      : `  <ul>\n${page.users
          .map(
            (user) => `    <li>
      <form method="post" action="${action}">
${hiddenFields(page.params, "        ")}
        <input type="hidden" name="orcid" value="${escapeHtml(user.orcid)}">
        <button type="submit">${escapeHtml(userLabel(user))}</button>${escapeHtml(standing(user))}
      </form>
    </li>`,
          )
          .join("\n")}\n  </ul>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>orcid-mock sign in</title>
<style>
body { font: 1rem/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; }
main { max-width: 40rem; margin: 0 auto; }
ul { padding-left: 1.25rem; }
li { margin: 0.5rem 0; }
button { font: inherit; padding: 0.4rem 0.8rem; margin-right: 0.5rem; }
</style>
</head>
<body>
<main>
  <h1>orcid-mock sign in</h1>
  <p>This is a test double for ORCID, not the real service.
  <strong>${escapeHtml(page.client.name)}</strong> asks to access a fictional ORCID record.</p>
  <h2>Requested access</h2>
  <ul>
${scopes}
  </ul>
  <h2>Sign in as</h2>
${users}
  <h2>Or decline</h2>
  <form method="post" action="${action}">
${hiddenFields(page.params, "    ")}
    <input type="hidden" name="action" value="deny">
    <button type="submit">Deny</button>
  </form>
</main>
</body>
</html>
`;
}
