# Where your keys are kept

OpenFlow keeps the API keys and tokens you give it in one private file on your own machine, so every part of the product finds them in the same place.

## What it does

When you save a key on the Connections page or in the wizard, OpenFlow writes it to its server secret store, a private file only the account running OpenFlow can read. OpenFlow then hands the key to the agents it starts on the same machine. If you use the Vault page, the Vault is encrypted in your browser, and when you unlock it the browser copies your keys into that same store. Keys are never shown back to you in chat and never written to a log.

## Why you would want it

**Example:** you save a DeepSeek key once during setup. Later your agents restart overnight, and they still start on that key without you pasting it again.

**The problem it fixes:** keys scattered across files get lost, go stale, or stay behind after you remove them. One store means one place to check and one place to clean up.

## What it needs

Nothing extra. It works on every install. The Vault page is optional.

## How to set it up

1. Open Systems, then Connections, and find the service.
2. Paste the key and press the test button.
3. Remove a key the same way when you no longer want it.

## How to tell it is working

The Connections card shows **On** after the test passes, and an agent for that service starts and answers. When you remove the key, the card goes back to off.

**What it stores:** the keys you save, in a private file on your machine. They never leave it, except to the provider the key belongs to.
**Careful:** every agent OpenFlow starts on the same machine can read the key it is given, and an agent that can run commands could print its own environment. Only save keys you are happy for your own agents to use.
**Agents use a key without seeing it:** when Jack or another agent needs a saved key to do something, such as checking that your DeepSeek key works, it asks OpenFlow to do the step for it. OpenFlow runs the step with the key and returns only the result, with the key replaced by `[hidden]`. You approve each step first, and an approval works once, for that exact step, for ten minutes. You can read what was run on the broker log in the dashboard. In this first version the only step is checking a key. Starting an agent with its key follows later. A provider key an agent runs on is in that agent's own process, so the agent's own tools can read it.

**Encrypted on disk:** every key in the store is encrypted with a key this server holds, so agents keep working after a restart and nobody types a password. That protects a copy of the key file on its own: a backup of the data folder, a support bundle, a synced folder. The encryption key is kept in a separate file outside the data folder (`~/.config/devflow/secrets.key`, which in the container is `/data/home/.config/devflow/secrets.key` in a different volume), or in `DEVFLOW_SECRETS_KEY` if your launcher sets it. It does not protect against someone who controls the running server or has the whole machine, because the app has to be able to read the encryption key. Back that key file up separately: if it is lost, the saved keys cannot be recovered. Older provider keys saved by the wizard in `credentials.json` are still a separate copy until a follow-up fixes it.
**Last checked:** 4 Nov 2026, from the code and the merged key-store change.
