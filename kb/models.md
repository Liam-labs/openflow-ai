# AI models and sign-ins

OpenFlow does not include an AI. It starts an AI tool you already have an account for, and that tool does the thinking.

## What it does

You connect at least one model in the setup wizard. You can sign in to **Claude Code** or **Codex** with your own subscription, or give an **API key**. OpenFlow starts the tool the way you would start it yourself. Sign-ins stay in the tool's own folder, and OpenFlow never reads them. API keys go into OpenFlow's private secret store on your machine.

## Why you would want it

**Example:** your Claude allowance runs out on Wednesday. If you also have another model connected, your team keeps working instead of sitting idle until it resets.

**The problem it fixes:** agents cannot start until one model works, and one provider's limit or price can stop everything. Each provider has its own price and strengths, so you can mix them.

## What it needs

An account with at least one provider. A subscription or an API key both work. If you set an API key for Claude Code, it uses the key instead of the subscription.

## How to set it up

1. Open the wizard's AI access step.
2. Press **Sign in to Claude Code** or **Sign in to Codex**, or paste an API key.
3. For a sign-in, follow the link the wizard shows, sign in on the provider's page, then paste or type the code back.

## How to tell it is working

The wizard reports the tool as logged in, and the first agents answer their hello message. If it fails, the agents do not start and the wizard says so.

**DeepSeek is the suggested first model.** The credentials step puts a DeepSeek key field first, with a how-to and a rough cost. See [DeepSeek](deepseek.md).
**Careful:** each provider has terms about using a subscription with other software. Read them first. They are yours to follow.
**Last checked:** 4 Nov 2026, from the README. A real Codex sign-in on a VPS was tested on 2 Nov.
