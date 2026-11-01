# First login on a server

A server install requires a login even when requests arrive through a local reverse proxy. The installer creates a random setup code. It stores only the code's hash. The code expires after 60 minutes and can create one owner login.

## Docker with HTTPS

Set `OPENFLOW_HOST` to the public hostname, without `https://` or a path. Run:

```sh
export OPENFLOW_HOST=your-server.example.org
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build
```

Configure Caddy to forward that hostname to `127.0.0.1:3000`. Use `docker/Caddyfile.template` as the template. Caddy must be able to receive connections on ports 80 and 443. Keep the application's published port on loopback.

Read the first-login code in the container's startup output. Open `/setup` on your HTTPS hostname. Enter the code and choose a password. A successful claim creates the password and signs that browser in. It does not require an API token in the browser.

If the code expires, issue a new one on the server:

```sh
docker compose exec openflow python3 scripts/setup-code.py
```

An existing owner password prevents issuing or claiming another first-login code. Use the existing password recovery command if you lose your password. Do not share setup codes, passwords or container startup logs.

The container's health check uses its own access token internally. The health API stays protected from anonymous requests.

## Native installation

Run `./scripts/setup --server --host your-server.example.org`. The installer writes the server settings and permitted HTTPS hostname. It prints a one-time code after installation. Configure your HTTPS proxy before opening the setup page.

## Test status

The backend has focused tests for concurrent claims, expired codes, repeated use, password reset, rate limits, session cookies and cross-site requests. A production Docker build and live API checks pass on an isolated VPS install. The owner login survives a container restart. The complete browser journey is under test. The first-login screen is a separate change and must be included before this journey is available.
