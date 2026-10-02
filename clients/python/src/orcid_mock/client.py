"""A typed client for orcid-mock's admin API and the headless sign-in sequence."""

from __future__ import annotations

from typing import Any, Literal, NotRequired, Self, TypedDict
from urllib.parse import parse_qs, quote, urlsplit

import httpx

STARTER_CLIENT_ID = "APP-ORCIDMOCK000001"
"""The starter users file's public client, which ``sign_in`` uses unless told otherwise."""
STARTER_CLIENT_SECRET = "orcid-mock-secret"  # noqa: S105 (the starter fixture's published secret)
STARTER_REDIRECT_URI = "http://localhost:3000/callback"

User = dict[str, Any]
"""A user in the users-file form (``fixtures/users.schema.json``); the server validates it."""

ClientRegistration = dict[str, Any]
"""An OAuth client in the users-file form: ``client_secret``, ``redirect_uris``, and so on."""


class Health(TypedDict):
    """The answer of ``health()`` and ``reset()``."""

    status: Literal["ok"]
    users: int
    clients: int


class TokenResponse(TypedDict):
    """The body of a successful token response; ``name`` is absent for client credentials."""

    access_token: str
    token_type: str
    refresh_token: str
    expires_in: int
    scope: str
    orcid: str | None
    name: NotRequired[str]
    id_token: NotRequired[str]


class OrcidMockError(Exception):
    """A request the mock refused, or an answer the helper could not use."""

    def __init__(self, message: str, status: int = 0, body: str = "") -> None:
        super().__init__(message)
        self.status = status
        """The HTTP status, or 0 when the answer was not an HTTP error (a redirect with no code)."""
        self.body = body
        """The response body text, empty when there was none."""


class OrcidMockClient:
    """Drives one orcid-mock over HTTP.

    ``base_url`` is the address the test reaches it at, and for a container the same as its
    ``PUBLIC_BASE_URL``. Every non-2xx answer raises ``OrcidMockError`` with its status and body.
    """

    def __init__(self, base_url: str, *, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        # trust_env=False: a proxy named by HTTP_PROXY or ALL_PROXY must not capture the traffic to
        # a mock on localhost, and a netrc entry or SSL_CERT_FILE has no business here either.
        self._http = httpx.Client(base_url=self.base_url, timeout=timeout, trust_env=False)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def health(self) -> Health:
        """``GET /__admin/health``."""
        return self._json("GET", "/__admin/health")

    def reset(self) -> Health:
        """``POST /__admin/reset``: back to the loaded file.

        Users, clients, counters, and the clock return to it, and codes, tokens, and sessions are
        cleared, so a client registered with ``put_client`` is dropped.
        """
        return self._json("POST", "/__admin/reset")

    def users(self) -> list[User]:
        """``GET /__admin/users``: every user, with minted iDs and put-codes filled in."""
        return self._json("GET", "/__admin/users")

    def user(self, orcid: str) -> User:
        """``GET /__admin/users/{iD}``; an unknown iD raises ``OrcidMockError`` with status 404."""
        return self._json("GET", f"/__admin/users/{quote(orcid, safe='')}")

    def create_user(self, user: User) -> User:
        """``POST /__admin/users``: create only; an omitted ``orcid`` mints one, a duplicate is 409.

        The answer is the stored user, with its iD and put-codes filled in.
        """
        return self._json("POST", "/__admin/users", user)

    def put_user(self, orcid: str, user: User) -> User:
        """``PUT /__admin/users/{iD}``: create or replace; the path iD wins."""
        return self._json("PUT", f"/__admin/users/{quote(orcid, safe='')}", user)

    def delete_user(self, orcid: str) -> None:
        """``DELETE /__admin/users/{iD}``; an unknown iD raises ``OrcidMockError``, status 404."""
        self._request("DELETE", f"/__admin/users/{quote(orcid, safe='')}")

    def put_client(self, client_id: str, client: ClientRegistration) -> ClientRegistration:
        """``PUT /__admin/clients/{client_id}``: register or replace an OAuth client."""
        return self._json("PUT", f"/__admin/clients/{quote(client_id, safe='')}", client)

    def advance_clock(self, seconds: float) -> int:
        """``POST /__admin/clock``: codes, sessions, and tokens expire without sleeping.

        Returns the new total offset in milliseconds; ``reset()`` zeroes it.
        """
        body = self._json("POST", "/__admin/clock", {"advance_seconds": seconds})
        return int(body["offset_ms"])

    def sign_in(
        self,
        orcid: str,
        *,
        scope: str = "/authenticate",
        client_id: str = STARTER_CLIENT_ID,
        client_secret: str = STARTER_CLIENT_SECRET,
        redirect_uri: str = STARTER_REDIRECT_URI,
        nonce: str | None = None,
    ) -> TokenResponse:
        """The headless sign-in: ``login_as``, the code from ``Location``, then the token exchange.

        ``GET /oauth/authorize`` is not followed, and ``POST /oauth/token`` is form-encoded.
        """
        params = {
            "client_id": client_id,
            "response_type": "code",
            "scope": scope,
            "redirect_uri": redirect_uri,
            "login_as": orcid,
        }
        if nonce is not None:
            params["nonce"] = nonce
        authorize = self._http.get("/oauth/authorize", params=params, follow_redirects=False)
        location = authorize.headers.get("location")
        if authorize.status_code != httpx.codes.FOUND or location is None:
            message = (
                f"GET /oauth/authorize answered {authorize.status_code}, "
                f"not a redirect: {authorize.text}"
            )
            raise OrcidMockError(message, authorize.status_code)
        # A refusal ORCID sends back to the client carries `error` in the fragment, not a code.
        codes = parse_qs(urlsplit(location).query).get("code")
        if not codes:
            # Not an HTTP error, so no status: see OrcidMockError.status.
            raise OrcidMockError(f"GET /oauth/authorize redirected without a code: {location}")

        token = self._http.post(
            "/oauth/token",
            data={
                "grant_type": "authorization_code",
                "code": codes[0],
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
            },
        )
        if token.status_code != httpx.codes.OK:
            message = f"POST /oauth/token answered {token.status_code}: {token.text}"
            raise OrcidMockError(message, token.status_code, token.text)
        return token.json()

    def _request(self, method: str, path: str, body: object = None) -> httpx.Response:
        response = self._http.request(method, path, json=body)
        if response.is_error:
            message = f"{method} {path} answered {response.status_code}: {response.text}"
            raise OrcidMockError(message, response.status_code, response.text)
        return response

    def _json(self, method: str, path: str, body: object = None) -> Any:  # noqa: ANN401
        return self._request(method, path, body).json()
