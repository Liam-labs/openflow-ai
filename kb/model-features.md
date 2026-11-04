# Model features

A model feature is an optional job that OpenFlow does with an AI model, such as keeping its own notes up to date. Each one is off until you turn it on, and you choose the model.

## What it does

Each feature has one card. The card shows the model you chose, exactly what would be sent to it, and a single confirm button. OpenFlow never picks a provider for you. It recommends one and says why, and the recommendation is never applied without your say-so. If the model needs a key you have not added, the card has an **Add the key** button. It opens Connections on that provider, and after the key is saved you come back to the same place and your choice is finished for you.

## Why you would want it

**Example:** you want OpenFlow to keep its notes about your project up to date without you asking. The card tells you in plain sentences which text would be sent and to which provider, you pick the cheapest model that suits you, and nothing leaves your machine until you confirm.

**The problem it fixes:** a feature that sends your text to an AI provider should never start by itself or choose its own provider. This keeps the decision, and the data, with you.

## What it needs

An API key for the provider you pick, added on the Connections page. A model that runs on your own computer needs no key and sends nothing out.

## How to set it up

Not available yet. The card is built, but no feature is switched on and the card is not on any page you can open. The server side is still being finished. When a feature is ready, its card will appear with a **Turn on** button and the data line above it.

## How to tell it is working

When a feature is on, its card shows the model it uses and **On**. If a feature is not ready, the server refuses to switch it on and the card says **Not available yet**. If the key is missing, the server says so and the card shows **Add the key**.

**What it stores:** the choice of model and level for each feature, on your machine.
**Not yet proved:** nothing here has run with a real provider key. The card and its tests exist, the Connections return trip works in a browser with a placeholder key, and every feature is still marked not ready.
**Last checked:** 4 Nov 2026, from the code, its tests and the 1 Nov browser report.
