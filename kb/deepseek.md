# DeepSeek, the suggested first model

DeepSeek is the quickest and cheapest way to give your agents a model. You paste an API key into the wizard, and the key stays on your machine.

## What it does

OpenFlow runs DeepSeek through its Claude wrapper, the same way it runs its other models. The key you paste goes into the Connections key store on your machine, the same place the Connections page saves keys. It is never typed into a chat and never shown back to you.

## Why you would want it

It costs very little. At DeepSeek's current peak-hours rate, a short chat message costs a fraction of a cent. See the cost line below. It suits a first try, and you can add other models later.

## What it needs

A DeepSeek account at https://platform.deepseek.com, some money on its balance, and an API key.

## How to set it up

1. Make an account on DeepSeek's platform site and add a small amount to your balance.
2. Create an API key there and copy it.
3. In the wizard's **AI access** step, paste the key into the **DeepSeek API Key** field at the top.
4. Press **Test**. A green "Connection verified" line means DeepSeek accepted the key. A red line gives the reason, for example a wrong key.

## How to tell it is working

The test passes, and your first agents answer their hello message. A wrong key shows a refusal on the test.

**Rough cost:** under $1 for every 1,000 short messages, at the default model's peak rate with no caching. Rates are half that off-peak. Check DeepSeek's own [price page](https://api-docs.deepseek.com/quick_start/pricing) for today's rates.
**What leaves your machine:** everything you or your agents say to the DeepSeek model is sent to DeepSeek to be answered.
**Not yet proved:** how DeepSeek limits spending, and how its top-up works. Check its site before you add money.
**Last checked:** 4 Nov 2026, prices read from DeepSeek's page that day.
