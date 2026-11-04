# Connections

Connections is the page that lists every service OpenFlow can connect to, and shows which ones are on, off or skipped for you.

## What it does

Each service has a card that says what it does and what it needs. Press **Connect** to open its setup wizard. The wizard tests the connection and returns you to the page you came from. A service that is not available says why, and an empty or failed status read never hides the list.

## Why you would want it

**Example:** you are away from your desk and want to check on the team from your phone. Connections shows phone access as Off and takes you through it, one screen at a time.

**The problem it fixes:** optional extras are hard to find and easy to half-set-up. Here each one has a plain card, and the status tells you what is really on.

## What it needs

Nothing for the page itself. Each service needs its own account or software, and its card says which.

## How to set it up

1. Open Systems, then Connections.
2. Find the service and press **Connect**.
3. Follow the wizard and press its test button.

## How to tell it is working

The card shows **On** after the wizard's test passes. **Off** and **Skipped** mean nothing is connected. Opening a login page is not a connection. Only a passed test is.

**Not yet proved:** Slack, Teams and WhatsApp setup screens work, but no real account has been connected. Cloudflare access from outside has not been tested with a real account. Tailscale has joined one test machine to a private network, and the remaining checks are in progress.
**Last checked:** 4 Nov 2026, from the live VPS tests of 2 to 4 Nov.
