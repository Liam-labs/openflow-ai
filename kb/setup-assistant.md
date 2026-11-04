# Jack, your setup assistant

Jack is a helper built into OpenFlow. He lives in a channel called **Setup**, which the wizard creates when your first team starts. He answers questions about what OpenFlow can do and walks you through setting it up.

## What it does

Jack greets you, asks a little about you and what you want to use OpenFlow for, then helps with the rest of setup. He keeps his messages short and takes one small point at a time. In this version he only guides: he explains, recommends and points you to the right screen. He is told never to ask for, show or store a password or key, and never to read your other channels. He cannot change settings or edit files.

## Why you would want it

**Example:** you finish the wizard and wonder whether you need Tailscale or your own domain to reach the dashboard from your phone. Instead of reading two pages, you ask Jack in a sentence, and he tells you what each one does and which one fits.

**The problem it fixes:** OpenFlow has many optional parts, and a new user cannot tell which matter. Jack answers in plain words and points to the screen.

## What it needs

A model to run on. The wizard starts Jack on the same AI you chose for your first team. A DeepSeek key is the quickest and cheapest way to give him one (see [DeepSeek](deepseek.md)). Without a working model Jack cannot answer.

## How to set it up

You do nothing. When the wizard finishes starting your first team, it also creates the Setup channel and starts Jack. The wizard's last button then reads **Meet Jack, your assistant** and opens that channel. It happens once. If you delete the channel it does not come back.

## How to tell it is working

The Setup channel exists, the Team panel shows Jack with the role **Assistant**, a strip of chips above his messages shows what is set up (owner password, phone access, your own domain, browser, shared memory) as On, Not set up or Skipped, and Jack sends a short hello and asks about you. If he stays silent, check that the AI you chose is installed and signed in, the same as for your first team.

**What leaves your machine:** what you type to Jack goes to the AI provider you chose, to be answered.
**Not yet proved:** no real Jack has answered on a real key yet. The channel, the hello and the opening button are built and tested, but not seen in a live install. The status strip is built and tested but has not been seen in a live install. Jack saving your bio to About you after you say yes has not been tried with a real model.
**Last checked:** 4 Nov 2026, from the code and its tests.
