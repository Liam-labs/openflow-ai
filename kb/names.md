# Your OpenFlow web address

On a VPS install, OpenFlow gives itself a free web address with trusted HTTPS, with no choice or setup from you.

## What it does

The installer claims a random name under `my.openflow-ai.com`, proves the claim, and gets an HTTPS certificate. The wizard shows the saved address and its progress. Opening or reloading the wizard never claims a second name.

## Why you would want it

**Example:** you rent a VPS and want to open OpenFlow on your phone over a safe connection. You do not own a domain and you do not want to learn DNS. The installer gives you a working address with a padlock.

**The problem it fixes:** a web address with trusted HTTPS usually means buying a domain and editing DNS records first.

## What it needs

A VPS install that can reach the OpenFlow names service. A domain of your own is optional.

## How to set it up

1. Run the VPS installer. The claim happens by itself.
2. Open the address the installer prints.

## How to tell it is working

The address opens with a padlock, and it is the same address after a reload. If the names service cannot be reached, OpenFlow falls back to a plain `sslip.io` address on your server's IP. That address still works and is also HTTPS.

**Not yet proved:** using your own domain through Cloudflare has not been tested with a real account.
**Last checked:** 4 Nov 2026, from the live VPS tests of 1 to 2 Nov.
