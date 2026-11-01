# First login on a VPS

On a new server, open `/setup` and enter the one-time setup code from the installer. Choose a password with at least 12 characters and repeat it. After the server creates your login and the browser confirms its session, the normal setup wizard opens.

If the code is invalid or expired, obtain a new code from the installer. If a login already exists, use **Sign in to continue setup**. Too many attempts shows the wait time returned by the server. The page never retries a code by itself.

The setup page reads `GET /api/auth/setup`. It shows the first-login screen only when both `serverMode` and `needsSetup` are true. Local installs continue to the existing wizard. Existing server installs check `/api/auth/session` and offer sign-in if needed. A failed status check stays on a retry screen.

The form sends `{ code, newPassword }` to `POST /api/auth/setup` and then verifies the session at `/api/auth/session`. The code and password stay in component memory, are never placed in a URL or browser storage, and clear after success. Deploy the setup-code backend with these screen changes; an older backend without the status endpoint cannot load this entry screen.

The component tests cover validation, duplicate submissions, server refusals, retry, and session-cookie failure. A real VPS browser test is still required for deployment acceptance.
