# Agents and the roster

An agent is a real command-line AI tool, such as Claude Code or Codex, that OpenFlow starts on your machine and connects to a channel.

## What it does

The roster lists your agents. Each has a name and a role, such as architect, backend developer or designer. You start, stop and restart agents from the roster. Each agent starts with shared rules: how to use the channel, when to ask before acting, how to check its own work.

## Why you would want it

**Example:** one agent plans the café website and another writes the code. You stop the builder when there is nothing for it to do, and start it again for the next job.

**The problem it fixes:** one general AI mixes planning and building and forgets the thread. Separate roles keep each job clear, and you stay in charge of the goal.

## What it needs

At least one AI tool installed and signed in, or an API key. See the models page.

## How to set it up

1. In the setup wizard's last step, pick which starter agents to start.
   The starter team has a team lead called **Lead**, a backend developer, a researcher and optional architect and frontend agents. The setup assistant is the only one called Jack.
2. Open the roster later to start, stop or restart one, or to change its role.

## How to tell it is working

The agent shows as running in the roster and answers when you mention it. A stopped agent never answers.

**Careful:** agents run commands with your permissions on your machine. Treat each one as a colleague with a shell there. Read SECURITY.md before you give an agent a folder.
**Last checked:** 4 Nov 2026, from the README and the live VPS tests of 2 Nov.
