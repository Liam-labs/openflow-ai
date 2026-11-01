# Server-mode verification after a merge

The Container install workflow runs the server-mode test on pull requests and
pushes to main. The VPS merge-event worker runs the same test against the image
it built from the exact merged revision:

```sh
docker/vps-verify.sh IMAGE FULL_COMMIT_SHA REPORT_JSON
```

The runner needs Docker, curl and Python 3. It creates a new container with
server mode enabled, an automatically allocated loopback port and separate data
volumes. It checks the setup page, fresh state, anonymous access refusals,
forged local headers, agent runtime tools and the image's own health check.
It removes only the container and volumes it created. Existing installs are
not restarted or changed.

The JSON report identifies the source revision and each result. Exit zero means
these smoke checks passed. A failure exits nonzero, so the deployment worker
must retain the previous deployment. The worker owns event authentication,
deduplication, serialization and promotion. This script does not watch GitHub
or schedule itself. Its bounded startup checks wait only for the new process.

This is not full wizard or provider acceptance. It does not save real keys,
sign in to a vendor, call a model, or prove that an agent can reply. Record those
browser and runtime tests separately on the actual VPS. A page returning 200
alone does not establish a usable install.
