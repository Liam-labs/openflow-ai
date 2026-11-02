# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report. Include what you found, how to reproduce it, and which version you used. You will get a reply as soon as a maintainer reads it.

Include what you found, how to reproduce it, and the version. We aim to acknowledge a report within 3 working days and to tell you what we plan to do within 14.

## What this project assumes

- It is meant to run on a machine you control, for one person or a small team who trust each other. It is not a hosted multi-tenant service.
- The dashboard listens on this machine only by default. Putting it on a network is your decision. Protect it with the access token and a firewall.
- Agents run commands on your machine with your permissions. Treat the agents you start like a colleague with a shell on that machine.
- Provider logins and API keys belong to you. This project never stores a login for one provider on behalf of another person.

## How access is controlled

This is what the code does today, so you can judge whether it fits how you plan to run it.

**Who can call the API**
- Every API route checks the caller before it does anything. A caller is accepted if it sends a valid access token (`Authorization: Bearer dvf_...`), or if it comes from the same machine (see below). `scripts/security-open-routes.txt` lists the few routes that are open on purpose, each with its reason. `node scripts/security-routes.mjs --fail-on-open` fails if a new route has no check. It also runs in the test suite.
- The setup script creates one access token for you and stores only its hash in `.AppData/api-tokens.json`. You can revoke tokens. After 5 wrong tokens from one address, OpenFlow locks that address out for 15 minutes. Every token has a request limit (100 per minute by default).

**"Same machine" requests**
- The dashboard and the command-line tools on your own machine do not need the token. A web page open in your browser is also "your machine", so a page on any other site could try to call `http://localhost:3000`. To stop that, OpenFlow trusts a same-machine request only when two things are true. It was sent to `localhost`, an IP address or this machine's own name. And it carries no cross-site browser marking (`Origin` / `Sec-Fetch-Site`). Everything else needs the token.
- `DEVFLOW_ALLOWED_HOSTS` and `DEVFLOW_ALLOWED_ORIGINS` add names you use on purpose (for example a reverse-proxy name). `DEVFLOW_ORIGIN_CHECK=report` logs what it would refuse, without refusing it. Use it for one day when you first add a proxy. `off` turns both checks off, and it is not safe on a computer you browse with. Any web page open in your browser, on any site, can then use OpenFlow as you without the token: read your channels, start agents and send them instructions. If the check refuses something you need, use `report` for a day and add the name it logs to `DEVFLOW_ALLOWED_HOSTS` or `DEVFLOW_ALLOWED_ORIGINS` instead.
- `DEVFLOW_REQUIRE_TOKEN=1` ends same-machine trust completely: every request needs the token.

**If you put it on a network**
- It listens on `127.0.0.1` only unless you set `DEVFLOW_BIND_HOST`. If you set it to anything else, OpenFlow switches same-machine trust off automatically, because a caller on the network can send `X-Forwarded-For: 127.0.0.1` itself. Every request then needs the token.
- OpenFlow does not believe the `X-Forwarded-For` header, because any client can write it. When the server starts, it takes over the connection itself: for every request it records the address of the computer on the other end, as the operating system reports it, and deletes any copy of that record the caller sent. It treats a request as "same machine" only when that address is this machine's own (or a Tailscale peer, if you set `DEVFLOW_TRUST_TAILNET=1`). A computer on your network that sends `X-Forwarded-For: 127.0.0.1` is refused. If the server cannot take over the connection, it switches same-machine trust off and every request needs the token.
- A reverse proxy that runs on the same computer connects from that computer. OpenFlow refuses same-machine trust for a request that carries a proxy header (`X-Real-IP`, `Forwarded`, `Via`, `X-Forwarded-Server`, `True-Client-IP` and similar) or that arrives over HTTP/1.0, which is what nginx speaks to the app by default. A proxy that adds none of these and speaks HTTP/1.1 cannot be told apart from a program on your computer. **If you run any reverse proxy, set `DEVFLOW_REQUIRE_TOKEN=1`.** Use HTTPS. The token is a password.
- The container image makes the same choice for you. Its forwarder accepts connections only from Docker's own gateway address, so a dashboard published on `127.0.0.1` works and another container on the same Docker network is refused.
- Agents you start can run commands as your user. The access token lets a caller start and stop agents, so keep it as private as a shell login.

**Signing in from another computer (the dashboard password)**
- On the machine itself the dashboard opens without a login. From any other computer there is nothing to trust, so you set an owner password on the machine (`scripts/devflow-password set`, asked twice, never printed) and other browsers sign in at `/login`. OpenFlow stores the password only as a scrypt hash in `.AppData/dashboard-auth.json` (mode 0600). The password needs at least 12 characters. Five wrong passwords from one address lock that address out for 15 minutes. Forty wrong passwords across all addresses in an hour stop a guesser who spreads attempts over many addresses.
- A signed-in browser gets a session cookie (`HttpOnly`, `SameSite=Strict`, `Secure` over https), stored on the server only as a hash. It ends after 7 days unused or 30 days in all, on sign-out, and whenever the password is changed or reset. Anything that changes data also has to come from the dashboard page itself, not from another site.
- A session can do what the dashboard does. It cannot do what is kept for the machine itself and tokens: restart WSL, systemd, browse folders, run dev servers (`requireTokenOrLocal` routes), use the agent API (`/api/agent`), or change the password. Treat the password like a shell login: whoever signs in can drive your agents.
- Locked out? On the machine run `scripts/devflow-password reset`. It forgets the password and every session. Sign-in stays off until you set a new one.
- **Start-up refusal.** If other computers can reach the dashboard and no password exists, it will not start. Other computers can reach it when it listens beyond this machine, when remote access was switched on in the setup wizard, or when a tunnel secret is set. The dashboard prints the one command that fixes it and exits with code 78 (PM2 is told not to restart on 78). It checks this at every start, so editing a settings file later cannot quietly reopen it. A server that already has its own front door (a tunnel that demands a login, a VPN) can set `DEVFLOW_ALLOW_OPEN_REMOTE=1` instead.

**What the app contacts**
- Nothing outside your machine until you configure an integration. With no integration set, the only outbound calls are the ones you start (package install during setup). Fonts are served from the app itself and Next.js usage reporting is switched off by the setup script. `scripts/security-outbound.py` lists every external address in the source with the reason it is there and fails if a new one appears unreviewed.
- Slack, Teams, WhatsApp, your model providers and Supabase are used only after you add their keys. Their webhook endpoints check a signature or bot token. The Teams bridge no longer has a built-in secret: it uses `TEAMS_NOTIFICATION_SECRET` or generates a random one stored in `.AppData/`.

**Secrets**
- Keys live in `.env` (mode 0600) and `.AppData/`. Neither is committed (`.gitignore`).

## Supported versions

Security fixes go to the latest release.
