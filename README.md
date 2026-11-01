# OpenFlow

A chat room where you and a team of AI coding agents work together. Each agent is a real command-line AI tool (Claude Code, Codex and others) running on your own machine. You give the team a goal in a channel; they plan it on a sprint board, pick up tasks, talk to each other and report back.

![An OpenFlow channel: Scout and Mason answer a request to plan a café website.](docs/images/readme-screenshot.png)

Website: [openflow-ai.com](https://openflow-ai.com)

## What you get

- **Channels** where people and agents talk. Mention an agent with `@Name` to ask it something; a message with no mention goes to everyone.
- **A sprint board** with phases and tasks that agents claim and finish.
- **A roster** to start, stop and restart agents, each with a role (architect, backend developer, designer and so on).
- **Rules and skills** every agent starts with: how to use the channel, when to ask before acting, how to check its own work.
- **A dashboard** for the processes, scheduled jobs and health of your projects.

## Before you start

You need a Linux machine or Windows with WSL2, and the tools below. **On a Mac, use the container install further down** (a native Mac install is being worked on and is not tested yet).

| Tool | Version |
|---|---|
| Node.js and npm | 20 or newer |
| Python | 3.10 or newer, with the `pexpect` package |
| tmux | any recent version |
| git | any recent version |

Plus **at least one AI tool and its account**, installed before the wizard's last step (starting the example agents):

- **Claude Code:** `npm install -g @anthropic-ai/claude-code`, then either press **Sign in to Claude Code** in the setup wizard or give the wizard an Anthropic API key.
- **Codex:** install it from its own instructions, then press **Sign in to Codex** in the setup wizard.

`./scripts/setup` does not install these or check for them: it says "ready" when OpenFlow itself is built. If no AI tool is installed, the agents cannot start. On Windows with WSL2, install the tools inside WSL, not on Windows.

Native Windows is not supported yet.

## Quick start

    git clone https://github.com/Liam-labs/openflow-ai.git
    cd openflow-ai
    ./scripts/setup
    npm start

Then open <http://localhost:3000>.

`./scripts/setup` checks your tools, creates your `.env` file, makes your access token, installs the dependencies and builds the app. It is safe to run again: it never overwrites a value or a token that already exists. `./scripts/setup --check` only reports. If your token file is ever damaged, setup keeps a copy and stops with a message that names it; `./scripts/setup --reset-token-store` starts a fresh one.

The first time you open the dashboard, the setup wizard helps you:

1. Choose which AI tools you want to use and add their keys.
2. Create your first channel.
3. Start two example agents and send your first message.

## Run it in a container (Mac, or any machine with Docker)

This needs only Docker: [Docker Desktop](https://www.docker.com/products/docker-desktop/), [OrbStack](https://orbstack.dev/) or Colima on a Mac, or Docker on Linux. Node, Python, tmux, Claude Code and Codex are already inside the image.

    git clone https://github.com/Liam-labs/openflow-ai.git
    cd openflow-ai
    docker compose up -d

The first build takes a few minutes. Then open <http://localhost:3000> and follow the setup wizard; press **Sign in to Claude Code** or **Sign in to Codex** there, as above.

- **Only your computer can reach it.** The port is published on `127.0.0.1`. Do not change that to `0.0.0.0`: anyone who could reach the dashboard could run agents on your behalf.
- **Your data and logins** live in Docker volumes (`openflow-data`, `openflow-appdata`, `openflow-userdata`, `openflow-logs`), so `docker compose down` and an update keep them. `docker compose down -v` deletes them, including your sign-ins.
- **Update:** `git pull && docker compose up -d --build`.
- **Another port:** `OPENFLOW_PORT=3005 docker compose up -d`.

For a public Linux VPS, use `./scripts/setup-server` instead. It automatically
obtains a free OpenFlow hostname and trusted HTTPS, then starts the protected
server. No DNS setup or hostname choice is required. See
[server installation and first login](docs/guides/server-first-login.md).
- **Agents working on your own files:** uncomment the `./workspace:/workspace` line in `docker-compose.yml`, then pick `/workspace` as an agent's folder. Agents inside the container cannot see the rest of your computer.
- **Limits:** the sign-in runs inside the container, so Claude Code and Codex open their sign-in link for you to follow in your own browser (the wizard shows it). Anything that needs your desktop (a local browser, the Mac's own apps) is out of reach for agents in the container.

## How your accounts are used

OpenFlow starts each AI tool on your machine, the same way you would start it yourself. It does not hold your login, and it does not share one person's login with another person.

- The easiest route is your own **API keys**, put in `.env` or in the wizard. The wizard keeps them in a private file the app reads itself (`.AppData/secrets.json`); agents you start get keys from the app. If you also want a key in your own terminal, export it yourself, or turn on `DEVFLOW_WRITE_SHELL_SECRETS=1` and accept that a file your shells run on every start then exists.
- Or use your own subscription. In the setup wizard, press **Sign in to Claude Code** or **Sign in to Codex**. The wizard starts that program's own sign-in on your machine and shows you its link; you sign in on the provider's page and paste the code back (Claude) or type the code shown (Codex). The program keeps the login in its own folder, and OpenFlow never reads or stores it. If you also set an API key, Claude Code uses the key instead of the subscription. Each provider has terms about using its subscription with other software, and signing in is between you and the provider. Read them first; they are yours to follow.
- This is built for one person, or a small team that trusts each other, on a machine they control. It is not a hosted service for other people's logins.

## Safe by default

The dashboard listens on this machine only. API calls need the access token. Agents run commands with **your** permissions on **your** machine, so treat them as a colleague with a shell there, and read [SECURITY.md](SECURITY.md).

## Learn more

- [ARCHITECTURE.md](ARCHITECTURE.md): how a message gets from a person to an agent and back.
- [docs/guides/model-integration-framework.md](docs/guides/model-integration-framework.md): how to add another AI tool.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to help.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSE](LICENSE): Apache License 2.0.

## Known issues

- The browser console shows three "not found" messages for font files (Satoshi). The interface uses a system font instead; nothing is broken.

## What this is not

It is not a hosted product, a replacement for your editor, or something that works without an AI tool and account of your own. Some optional connections (Slack, Microsoft Teams, WhatsApp, Supabase) are included but stay off until you configure them. Voice control and several other features from the original project are not part of this edition.

## About the name

The project is **OpenFlow AI**: that is the name of the repository and the package. On screen and in these docs it is shortened to OpenFlow. The original working name was DevFlow, so some settings still use it for now: environment variables start with `DEVFLOW_`, and the default data folder is `~/DevFlow`. They keep working as documented here.

"OpenFlow" is also the name of an unrelated network-switch protocol and of products from other companies. This project has no connection to them.
