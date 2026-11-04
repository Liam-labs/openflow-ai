# Shared memory for your team

Shared memory lets your agents save notes and find them again later by meaning, not just by exact words. It is an optional add-on and it is off until you turn it on.

## What it does

It runs a small search database called Qdrant and a small local model on your own machine. Agents write notes into it, and any agent can search them. It stores the notes agents write, not your files.

## Why you would want it

**Example:** on Monday you tell the team to use British spelling and the café's brand colours. On Friday a new session still follows that, because an agent saved the note and another one found it.

**The problem it fixes:** agents forget everything between sessions, so you repeat yourself. Skip memory if you want the simplest setup, because everything else works without it.

## What it needs

On your own computer, Docker, or a Qdrant database already running on port 6333. A server install manages its own private database and needs no Docker. It also needs some disk space for the local model.

## How to set it up

1. Open Systems, then Connections, then **Set up more**.
2. Under "Give your agents more to work with", find **Shared memory for your team**.
3. Press the setup button and follow the checks.
4. Finish with the built-in test. It stores a note and searches for it.

## How to tell it is working

The test finds the note it stored, and the card shows **On**. Switching it off stops the database and keeps your saved notes.

**What it stores:** only the notes agents write, in a folder on your machine. The database cannot be reached from outside the machine.
**Not yet proved:** the add-on's search has passed on a live VPS using test data. No agent has yet stored and recalled a real note.
**Last checked:** 4 Nov 2026, from the live VPS tests of 2 Nov.
