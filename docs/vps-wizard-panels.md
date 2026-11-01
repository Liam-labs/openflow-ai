# Wizard panels on a server

Settings closes its menu backdrop while a child panel is open, so Messaging Bridges and Computer Use accept ordinary clicks. Slack and Teams details load their configuration and status endpoints and open their setup wizards from the detail screen. Failed reads offer retry.

The desktop installation wizard configures Windows through WSL. On a native Linux server it explains that limitation and does not offer Windows installation commands or claim that desktop control is configured. This does not prevent using an independently configured remote desktop bridge.

The Vault, Gateway and Computer Use header destinations have pages. Backups displays an unavailable message because this installation does not include its service; visiting that page does not create a backup.

These repairs do not establish a live provider or messaging connection. Those require the chosen service's credentials and a successful end-to-end test.
