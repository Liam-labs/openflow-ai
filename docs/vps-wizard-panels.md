# Wizard panels on a server

Settings closes its menu backdrop while a child panel is open, so Messaging Bridges and Computer Use accept ordinary clicks. Slack and Teams details load their configuration and status endpoints and open their setup wizards from the detail screen. Failed reads offer retry.

The desktop installation wizard configures Windows through WSL. On a native Linux server it explains that limitation and does not offer Windows installation commands or claim that desktop control is configured. This does not prevent using an independently configured remote desktop bridge.

The Vault and Computer Use header destinations have pages. Vault setup keeps passkey and recovery-code steps visible after creating its password. Messaging Bridges uses a platform selector on phones. Gateway and Backups display unavailable messages because this edition does not include their services; visiting that page does not create a backup.

These repairs do not establish a live provider or messaging connection. Those require the chosen service's credentials and a successful end-to-end test.

The dashboard's event-stream fallback keeps its refresh interval when a component rerenders. Changing a response-transform callback no longer starts another immediate request, and leaving the screen cancels pending fallback requests.
