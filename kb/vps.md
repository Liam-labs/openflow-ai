# Running OpenFlow on a VPS

A VPS is a computer you rent that stays on all the time. Running OpenFlow there means you reach it from anywhere and your agents keep working when your own computer is off.

## What it does

On a public Linux VPS, one install script sets up OpenFlow behind secure HTTPS. It claims a free OpenFlow web address for you automatically, so you choose no name and do no DNS work. Your data and sign-ins live in four Docker volumes, so an update keeps them.

## Why you would want it

**Example:** you give the team a big job at bedtime and close your laptop. On a VPS the agents keep working overnight, and you read the result on your phone in the morning.

**The problem it fixes:** on your own computer, agents stop when it sleeps or shuts down. A VPS is always on. It is not for sharing one login between strangers, because OpenFlow is built for one person, or a small team that trusts each other.

## What it needs

A Linux VPS with Docker, and its login details. Prices vary, so check your provider. You also need an AI tool account, as on any install.

## How to set it up

1. On the VPS, get the OpenFlow code and run `./scripts/setup-server`.
2. The installer prints a one-time setup code and your new address.
3. Open `/setup` on that address, enter the code, and choose a password of at least 12 characters.
4. Continue with the normal setup wizard.

## How to tell it is working

Your address opens with a padlock and shows the sign-in page. After the wizard, an agent you mention answers in the channel. If the code is invalid or expired, get a new one from the installer.

**Careful:** do not publish the container's port to the whole internet yourself. Keep the installer's setup.
**Last checked:** 4 Nov 2026, from a fresh install and the public VPS tests of 1 to 2 Nov.
