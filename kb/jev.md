# TypeSafe Jev: skill hints for your agents

Jev is a very fast checker that tells an agent which of its skills a task probably needs. You turn it on with a TypeSafe key, and it only adds one line to a message.

## What it does

Before an agent reads a message, Jev reads it first and guesses which skill fits, for example design, testing or a particular tool. It adds one hint line to the message. The agent can ignore the hint. Jev does not run anything and does not change your files.

## Why you would want it

**Example:** you ask an agent to "make the landing page look better". The agent has dozens of skills and is not sure which one applies, so it often starts without any. With Jev on, the message arrives with a line saying the design skill probably fits, and the agent uses it.

**The problem it fixes:** agents do not always remember which of their skills to reach for. A short hint at the right moment is cheaper than hoping they do.

## What it needs

A TypeSafe account and an API key. It is pay-per-use, and you top up a balance first. The Connections card shows the current cost. It is off until you switch it on.

## How to set it up

1. Open Systems, then Connections, and find **TypeSafe Jev**.
2. Press **Get a TypeSafe key**, sign in or create an account, and open the API keys page.
3. Add a little credit if it asks, create a key and copy it.
4. Come back to the card, paste the key and press the test button.
5. Switch on the skill hints option.

## How to tell it is working

The test passes and the card shows **On**. After that, a message to an agent can carry one extra hint line. If the key is wrong or the balance is empty, the card says so and agents work as before.

**What leaves your machine:** the text of each message Jev checks is sent to TypeSafe to be scored.
**Not yet proved:** I read the setup steps and cost from the Connections card in the code. No real TypeSafe key has been tested on a VPS install.
**Not in this edition:** nudging agents to keep their sprint-board tasks up to date is a different feature, and it is not part of OpenFlow yet.
**Last checked:** 4 Nov 2026, from the OpenFlow code.
