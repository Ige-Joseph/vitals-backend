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

Concurrent browser refreshes must be deduplicated by the client because refresh
tokens are single-use.

## Deployment migration

The body-based refresh-token contract remains temporarily available when the
`X-Auth-Transport` header is absent. This permits deploying the backend before
the updated browser application.

The updated frontend can migrate an existing session once by sending the legacy
refresh token in the request body with cookie transport enabled. It immediately
removes the old access token, refresh token, and Zustand auth record from Web
Storage.

After all supported browser releases have migrated, remove the legacy response
body behavior, make cookie transport the only browser contract, and update the
Swagger schemas accordingly.

## Production requirements

- Serve both applications over HTTPS.
- Configure exact frontend origins in `CORS_ORIGIN`; do not use `*`.
- Keep `credentials: true` enabled for approved origins.
- Prefer frontend and API custom domains under the same registrable domain to
  reduce dependence on third-party-cookie behavior.
- Never log raw access tokens, refresh tokens, cookie headers, or password-reset
  tokens.
- Return `Cache-Control: no-store` for API responses.

