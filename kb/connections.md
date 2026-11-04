# Connections

Connections is the page that lists every service OpenFlow can connect to, and shows which ones are on, off or skipped for you.

## What it does

The page has two tabs, **Connected** and **Set up more**. Each service has a card under **Set up more** that says what it does and what it needs. Opening a card shows a short step-by-step dialog with a test button. Slack, Teams and WhatsApp have a **Connect Slack, Teams or WhatsApp** button. A service that is not available says why, and an empty or failed status read never hides the list.

## Why you would want it

**Example:** you are away from your desk and want to check on the team from your phone. Connections lists phone access under Set up more and takes you through it, one step at a time.

**The problem it fixes:** optional extras are hard to find and easy to half-set-up. Here each one has a plain card, and the status tells you what is really on.

## What it needs

Nothing for the page itself. Each service needs its own account or software, and its card says which.

## How to set it up

1. Open Systems, then Connections, then **Set up more**.
2. Find the service and open its card.
3. Follow the steps and press the test button.

## How to tell it is working

The card shows **On** after the wizard's test passes. **Off** and **Skipped** mean nothing is connected. Opening a login page is not a connection. Only a passed test is.

**Careful:** a key you save here is kept in OpenFlow's private key file on this install, and it is also given to every agent that OpenFlow starts on the same machine. Agents that run on another computer do not get it. Only save keys you are happy for your own agents to use.
**Not yet proved:** Slack, Teams and WhatsApp setup screens work, but no real account has been connected. Cloudflare access from outside has not been tested with a real account. Tailscale has joined one test machine to a private network, and the remaining checks are in progress.
**Last checked:** 4 Nov 2026, from the live VPS tests of 2 to 4 Nov.
