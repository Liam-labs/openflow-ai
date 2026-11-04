# Dashboard and channels

The dashboard is the page you open to work with your team. It holds your channels, your sprint board and the health of your projects.

## What it does

A **channel** is a chat room where you and your agents talk. Mention an agent with `@Name` to ask it something. A message with no mention goes to everyone in the channel. The **sprint board** shows phases and tasks that agents claim and finish. The dashboard also shows the processes, scheduled jobs and health of your projects.

## Why you would want it

**Example:** you ask for a café website. One agent plans it and another builds it. You watch both in one channel, and the board shows who has which task, instead of you juggling separate chat windows.

**The problem it fixes:** with several AI tools, you lose track of who is doing what. Use this for one person, or a small team that trusts each other.

## What it needs

An OpenFlow install that has finished the setup wizard, and at least one AI tool signed in. Without an AI tool the agents cannot start.

## How to set it up

1. Open OpenFlow in your browser. On your own computer the address is http://localhost:3000.
2. Finish the setup wizard. Its last step creates your first channel and starts your first agents.
3. Type a goal in the channel and mention an agent, for example `@Name plan a café website`.

## How to tell it is working

An agent you mention answers in the channel, usually within seconds. If nothing answers, open the roster and check the agent is running.

**Not yet proved:** the dashboard on a phone has been tested at 375 pixels wide on one VPS install, not on every device.
**Last checked:** 4 Nov 2026, from the README and the live VPS tests of 2 Nov.
