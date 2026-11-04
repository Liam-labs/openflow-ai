# Shared memory for your team

Shared memory lets your agents save notes and find them again later by meaning, not just by exact words. It is an optional add-on and it is off until you turn it on.

## What it does

It runs a small search database called Qdrant and a small local model on your own machine. Agents you have given access to can write notes into it and search them. It stores the notes agents write, not your files.

## Why you would want it

**Example:** on Monday you tell the team to save its decisions as notes, including that you use British spelling and the café's brand colours. On Friday a new session searches those notes first and follows them, without you repeating yourself.

**The problem it fixes:** agents forget everything between sessions, and they only search memory when you tell them to. Skip memory if you want the simplest setup, because everything else works without it.

## What it needs

On your own computer, Docker, or a Qdrant database already running on port 6333. A server install manages its own private database and needs no Docker. It also needs some disk space for the local model.

## How to set it up

1. Open Systems, then Connections, then **Set up more**.
2. Under "Give your agents more to work with", open the card **Shared memory for your team**.
3. Follow its steps and checks.
4. Run the built-in test. It stores a note and searches for it.
5. After the test passes, press **Let my agents use it**. Until you do, agents cannot use memory.
6. Tell your agents to save notes and to search them first.

## How to tell it is working

The test finds the note it stored, and the card shows **On**. Switching it off stops the database and keeps your saved notes.

**What it stores:** only the notes agents write, in a folder on your machine. The database cannot be reached from outside the machine.
**Not yet proved:** the add-on's search has passed on a live VPS using test data. No agent has yet stored and recalled a real note.
**Last checked:** 4 Nov 2026, from the live VPS tests of 2 Nov.
