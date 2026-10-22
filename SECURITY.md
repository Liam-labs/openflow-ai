# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report. Include what you found, how to reproduce it, and which version you used. You will get a reply as soon as a maintainer reads it.

Include what you found, how to reproduce it, and the version. We aim to acknowledge a report within 3 working days and to tell you what we plan to do within 14.

## What this project assumes

- It is meant to run on a machine you control, for one person or a small team who trust each other. It is not a hosted multi-tenant service.
- The dashboard listens on this machine only by default. Putting it on a network is your decision; protect it with the access token and a firewall.
- Agents run commands on your machine with your permissions. Treat the agents you start like a colleague with a shell on that machine.
- Provider logins and API keys belong to you. This project never stores a login for one provider on behalf of another person.

## How access is controlled

This is what the code does today, so you can judge whether it fits how you plan to run it.

**Who can call the API**
- Every API route checks the caller before it does anything. A caller is accepted if it sends a valid access token (`Authorization: Bearer dvf_...`), or if it comes from the same machine (see below). A list of the few routes that are open on purpose, each with its reason, is in `scripts/security-open-routes.txt`; `node scripts/security-routes.mjs --fail-on-open` fails if a new route has no check, and runs in the test suite.
- The setup script creates one access token for you and stores only its hash in `.AppData/api-tokens.json`. Tokens can be revoked. After 5 wrong tokens from one address that address is locked out for 15 minutes; every token has a request limit (100 per minute by default).

**"Same machine" requests**
- The dashboard and the command-line tools on your own machine do not need the token. A web page open in your browser is also "your machine", so a page on any other site could try to call `http://localhost:3000`. To stop that, a same-machine request is only trusted when it was sent to `localhost`, an IP address, or this machine's own name, and carries no cross-site browser marking (`Origin` / `Sec-Fetch-Site`). Everything else needs the token.
- `DEVFLOW_ALLOWED_HOSTS` and `DEVFLOW_ALLOWED_ORIGINS` add names you use on purpose (for example a reverse-proxy name). `DEVFLOW_ORIGIN_CHECK=report` logs what would be refused without refusing it (use it for one day when you first add a proxy); `off` turns the check off.
- `DEVFLOW_REQUIRE_TOKEN=1` ends same-machine trust completely: every request needs the token.

**If you put it on a network**
- It listens on `127.0.0.1` only unless you set `DEVFLOW_BIND_HOST`. If you set it to anything else, same-machine trust is switched off automatically (a caller on the network can send `X-Forwarded-For: 127.0.0.1` itself), so every request needs the token.
- If you listen on all interfaces (`DEVFLOW_BIND_HOST=0.0.0.0` or `::`), set `DEVFLOW_REQUIRE_TOKEN=1`. A client can write an `X-Forwarded-For` header itself, so an address in that header must never be treated as proof the request came from this machine.
- Putting it behind a reverse proxy or tunnel: set `DEVFLOW_REQUIRE_TOKEN=1` unless the proxy removes any `X-Forwarded-For` header a client sends. Use HTTPS; the token is a password.
- Agents you start can run commands as your user. The access token lets a caller start and stop agents, so keep it as private as a shell login.

**What the app contacts**
- Nothing outside your machine until you configure an integration. With no integration set, the only outbound calls are the ones you start (package install during setup). Fonts are served from the app itself and Next.js usage reporting is switched off by the setup script. `scripts/security-outbound.py` lists every external address in the source with the reason it is there and fails if a new one appears unreviewed.
- Slack, Teams, WhatsApp, your model providers and Supabase are used only after you add their keys. Their webhook endpoints check a signature or bot token. The Teams bridge no longer has a built-in secret: it uses `TEAMS_NOTIFICATION_SECRET` or generates a random one stored in `.AppData/`.

**Secrets**
- Keys live in `.env` (mode 0600) and `.AppData/`. Neither is committed (`.gitignore`). `scripts/devflow-secret-exec` (optional) starts a service with its keys fetched from 1Password at start time instead of from a file.

## Supported versions

Security fixes go to the latest release.
