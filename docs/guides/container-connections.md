# Connections in a server container

The Cloudflare, Tailscale, browser, memory and sign-in wizards accept a verified owner password session. Writes retain the existing same-origin check. Admin API tokens and trusted local use remain supported; tunnel headers alone do not authorize wizard administration.

The image includes cloudflared and Tailscale from their official signed Debian repositories. The entrypoint starts Tailscale as the unprivileged application user in userspace mode, with a separate socket and state under `/data/home/.openflow-tailscale`. It does not mount the host socket, require a TUN device, or change the host's administrative tailnet. Do not mount a host Tailscale directory there.

The owner starts sign-in with the wizard. `POST /api/wizards/tailscale` with `{ "action": "login" }` returns a provider approval URL; repeated requests reuse the active process. Approval completion emits `wizard:changed`. The wizard reads authoritative state on events and reconnect; no status polling is required. An isolated node reports `facts.isolatedNode: true`. Enable HTTPS certificates in the Tailscale account before enabling Serve: this server's owner session requires secure cookies. The adapter uses only private Serve, never Funnel.

Tailscale state is inside the existing `/data` volume and survives normal image recreation. Cloudflare's saved connector is restored on application startup only when its existing record says enabled and live. No tunnel or DNS record is provisioned by a page read or application restart.

The local reachability test uses the isolated daemon's loopback-only outbound proxy. It is not proof that a second device can reach the application. Independent acceptance still requires an authorized second device, owner sign-in, a real page, and persistence. Authenticated visits are distinguished from password bypasses.

Implementation references: [Tailscale userspace mode](https://tailscale.com/docs/concepts/userspace-networking), [official Debian packages](https://pkgs.tailscale.com/stable/#debian-bookworm), and [Cloudflare package repository](https://pkg.cloudflare.com/index.html).
