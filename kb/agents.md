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

The roster can show an agent as ready while it is stuck. If you ask an agent something and it has not answered after 45 seconds, the chat says so and shows the command that opens the agent's own screen, with a Copy button. On a container install it is `docker compose exec -it openflow tmux attach -t` followed by the session name, because the agent's terminal lives inside the container. Elsewhere it is `tmux attach -t` and the session name. The usual cause is a sign-in or a trust question waiting in that terminal, or no AI signed in on the computer. Answer it there, then press Ctrl+B and then D to leave the agent running.

**Careful:** agents run commands with your permissions on your machine. Treat each one as a colleague with a shell there. Read SECURITY.md before you give an agent a folder.
**Not yet proved:** the 45-second note is built and tested, but has not been seen with a real stuck agent on a Mac.
**Last checked:** 4 Nov 2026, from the README and the live VPS tests of 2 Nov.
