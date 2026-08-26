# Authentication Contract

## Token model

The API issues a short-lived JWT access token and a rotating opaque refresh
token. Refresh-token hashes are stored in PostgreSQL. Rotation revokes the
presented token before creating its replacement.

Browser clients use cookie transport:

```text
X-Auth-Transport: cookie
credentials: include
```

For signup, login, refresh, and logout, the server verifies that the request
`Origin` matches `CORS_ORIGIN` or `FRONTEND_URL`. It then stores the refresh
token in the `vitals_refresh` cookie with these properties:

- `HttpOnly`
- `Secure` in production
- `SameSite=None` in production and `Lax` in development
- path restricted to the configured API authentication prefix
- seven-day maximum age, matching the current server refresh-token lifetime

Cookie-transport responses include the access token and user but never include
the refresh token in JSON. Access tokens continue to be sent as Bearer tokens.

## Browser lifecycle

1. Signup or login establishes the refresh cookie and returns an access token.
2. The frontend retains the access token in memory only.
3. A page reload calls `POST /api/v1/auth/refresh` using the cookie.
4. The server rotates the refresh token and replaces the cookie.
5. Logout revokes the presented token and clears the cookie.

Clients should still deduplicate concurrent refreshes, but the server no longer
depends on it. See rotation grace window below.

## Rotation grace window

Refresh tokens are single-use, and presenting an already-rotated token is the
reuse signal described in OAuth 2.0 Security BCP section 4.14. Treating every
such request as theft is wrong for browsers: all tabs share one refresh cookie,
so session restore, a double reload, or two tabs opened together can present
the same token within milliseconds of each other.

Each rotation records the hash of the token that superseded it. When a revoked
token is presented, the server resolves it as follows:

1. If it was revoked more than 30 seconds ago, revoke every token for the user.
2. Otherwise follow the replacement chain, up to five hops, while each link was
   itself rotated inside the window.
3. If the chain reaches a token that is live, rotate from that token and return
   a new pair. The concurrent request succeeds.
4. If the chain ends in a revoked, expired, or missing token, revoke every
   token for the user.

Grace resolutions are logged at info, family revocations at warn. A stolen
token replayed inside the window succeeds, which is the accepted trade for not
signing users out during ordinary use; Auth0 and better-auth both default to
the same 30 seconds. Widening the window widens that exposure.

## Two transports, and which is which

The `X-Auth-Transport` header selects between them.

| Header | Refresh token travels in | For |
|---|---|---|
| `X-Auth-Transport: cookie` | `HttpOnly` cookie | Browsers |
| *(absent)* | The JSON response body | **Native clients**, and legacy browser sessions |

The trusted-`Origin` check applies only to cookie transport, so a native client
sending no `Origin` header is not affected by it.

### The body transport is the native contract — do not remove it

An earlier version of this document described the body-based contract as
"temporarily available", to allow deploying the backend ahead of the updated
browser application, and said to remove it once all supported browser releases
had migrated.

**That instruction is now wrong and should not be followed.** A React Native
client depends on this transport: it cannot use an `HttpOnly` browser cookie,
and it stores the refresh token in the platform keychain instead. Removing the
body response would break every mobile client at once.

What is safe to retire is the *browser's* use of it — a browser sending no
`X-Auth-Transport` header should be considered legacy. What must stay is the
transport itself. See [`MOBILE_API.md`](MOBILE_API.md) for the client contract
that depends on it.

### The one-time browser migration

The updated frontend migrates an existing session once by sending the legacy
refresh token in the request body with cookie transport enabled. It immediately
removes the old access token, refresh token, and Zustand auth record from Web
Storage. That path is browser-specific and can be removed once no browser
session predates cookie transport.

## Production requirements

- Serve both applications over HTTPS.
- Configure exact frontend origins in `CORS_ORIGIN`; do not use `*`.
- Keep `credentials: true` enabled for approved origins.
- Prefer frontend and API custom domains under the same registrable domain to
  reduce dependence on third-party-cookie behavior.
- Never log raw access tokens, refresh tokens, cookie headers, or password-reset
  tokens.
- Return `Cache-Control: no-store` for API responses.

