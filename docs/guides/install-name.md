# Give a server its free OpenFlow name

The installer claims a generated name through `https://names.openflow-ai.com`.
It proves control of the server's HTTP port before the registry creates records
through PowerDNS. Do not create an install's DNS record by hand.

On a Linux VPS with Docker installed, run:

```sh
./scripts/setup-server
```

The installer discovers the public IPv4 address, claims a random name, serves
the proof, configures Caddy, checks DNS and trusted HTTPS, and starts the app.
There is no hostname choice or DNS task for the person installing it. On
Debian/Ubuntu it installs Caddy and Python cryptography when missing. The wizard
reads the saved result through authenticated `GET /api/setup/address`; opening
or reloading it never claims another name.

Native installs use `./scripts/setup --server` for the same automatic address
path. An explicit `--host` remains available for an operator supplying their own
already-configured hostname. Both installers need administrative access for
the host's web server and public ports 80 and 443.

Only an unreachable names service selects the sslip.io fallback. Quota,
invalid proof, bad registry certificates and certificate issuance failures are
reported as failures. The result records `claiming`, `certificate`, `ready` or
`failed`, with the actual URL and `managed` or `fallback` source. An install that
has not received a name yet has an empty URL; the browser must not invent one.

Keep the private install state with the server's backups. The key authorizes
future changes to this name. For Docker it lives under
`/var/lib/openflow-install-name/COMPOSE_PROJECT`; the public result is in the
persistent appdata volume. Updates reuse that key and claim.

## Operator recovery and protocol diagnostics

The lower-level client supports diagnosing a failed proof. These separate
commands are not the normal installation journey.

Run `scripts/setup-name.py claim` with these arguments:

```sh
sudo python3 scripts/setup-name.py claim \
  --state-dir /var/lib/openflow-install-name \
  --webroot /var/lib/openflow-claim \
  --public-state /path/to/persistent/appdata/install-address.json \
  --ip YOUR_PUBLIC_IPV4
```

The output contains only non-secret address state. The private directory holds
the install key and pending challenge. The public state file belongs in the
app's persistent `.AppData` volume, not in its source tree.

Add this HTTP-only handler to Caddy alongside the existing site. The registry
connects to the supplied IP with this Host header, so it works before DNS exists:

```caddyfile
http://claim.openflow.invalid {
    handle /.well-known/openflow-claim {
        root * /var/lib/openflow-claim
        file_server
    }
    handle {
        respond 404
    }
}
```

Validate and reload Caddy. Run the same command with `confirm` instead of
`claim`. Confirmation checks existing registry state before attempting the proof,
so it can recover when a successful response was interrupted. It removes the
challenge after activation. The registry writes the A and no-mail records.

Add the returned hostname as a Caddy HTTPS site proxying the app's loopback
port, then run `scripts/setup --server --host RETURNED_HOSTNAME` for a new native
install, or set `OPENFLOW_HOST` in server Compose. Preserve any old hostname as
a working fallback during a migration. Verify public DNS and a trusted HTTPS
certificate before selecting the new address in the wizard.

`status` checks the registry without creating a name. `update` sends a signed
address update and refreshes the registry's last-seen time; retain this key and
run it after address changes and before 30 days of inactivity. This client does
not install a scheduled renewal job. An interrupted initial claim is reported as
unknown and must be reconciled with the registry operator before requesting
another name. It never silently consumes another claim or replaces the key.

The registry URL and base can be configured with `--registry` and `--base`.
The client accepts HTTPS only, rejects redirects, and refuses names outside the
configured base. The UI must show unavailable while the registry or installer
has not completed provisioning; a local test is not proof of public DNS or TLS.
