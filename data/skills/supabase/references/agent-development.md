# Supabase agent development

Verified against official documentation on 7 October 2026. The owner authorized the
desktop CLI upgrade and development-workflow adoption that day. Use the default
below for new development; an existing live project's migration or app MCP
deployment still follows its own assigned scope. Recheck linked docs as needed.

## Choose the applicable workflow

- Schema/config work: use the project's chosen diff engine and tracked config.
- Parallel local experiments: consider experimental stacks in disposable worktrees.
- Agents acting for product users: use an app MCP endpoint with user permissions.
- Long-running hosted services: assess Compute only if the project has access.

The desktop WSL CLI is **2.120.0**, upgraded from 2.84.2 on 7 October 2026.
The official Linux archive contains **both `supabase` and `supabase-go`**;
install both beside each other. The archive SHA256 was verified against GitHub's
release digest and checksum list. Check the executable or project-pinned CLI
actually used by the target repo with `supabase --version` and command `--help`.
Pin a compatible CLI in projects/CI rather than assuming every host was upgraded.
[CLI installation/version guidance](https://supabase.com/docs/guides/local-development/cli/getting-started).

### Adopted default and desktop verification

For a new project, run `supabase init`, retain `[experimental.pgdelta] enabled =
true`, track config and `supabase/schemas/`, and use the reviewed migration loop
below. Use `supabase config pull --dry-run` before reconciling hosted settings;
check the target and resulting diff before writing them. Config pull requires a
linked/selected hosted project; the local adoption test did not exercise a
hosted pull or push.

For disposable isolated tests, initialize the intended directory with
`SUPABASE_EXPERIMENTAL_STACK=1 supabase init`. This records stack mode in that
project and omits fixed ports. Do not export the flag globally or silently opt
existing valued stacks into a different backend.

Desktop acceptance exercised two generated migrations, local application,
preservation of two test rows, a no-change sync, SQL privilege/RLS checks, and
an actual Data API request. Docker and native test stacks had different ports
and independent data. Native startup succeeded. Experimental Docker startup
intermittently failed with `PostgreSQL exited with code 1`, including repeated
failure for a second Docker stack; the cause remains unresolved. Therefore
parallel experimental Docker stacks are **not a reliable desktop default yet**.
Use the existing Docker workflow for valued development data; the native route
is available for disposable tests on this supported WSL host.

Local evidence and binary rollback:
`~/DevFlow/.AppData/runtime-upgrades/supabase-20261007/` (private command output,
probe config/schema/migrations, original `supabase-2.84.2` binary). Do not publish
raw status JSON: it contains generated keys and database connection credentials.

## Declarative schemas and config in code

Recent `init` uses `pg-delta`, still pre-1.0. Existing projects select it with:

```toml
[experimental.pgdelta]
enabled = true
```

Absent/false means legacy `migra`. On an adoption branch, reconcile migration
history with `supabase db pull`; review any catch-up migration and its applied
state before deployment. Remove legacy `schema_paths` when adopting pg-delta's
automatic ordering. Its `db diff` compares live databases, while declarative
files require `db schema declarative sync`. Do not use `db pull --declarative`
with migra. [Diff engine guide](https://supabase.com/docs/guides/local-development/diff-engines).

For an existing database, establish a migration baseline first (`supabase db pull`
if history is empty), then export with
`supabase db schema declarative generate --linked`. Export alone does not create
that baseline. Review existing files before replacing them.

Edit `supabase/schemas/`, then:

```bash
supabase db schema declarative sync -f change_name --no-apply
# Review generated SQL, especially drops, grants and RLS changes.
supabase start
supabase migration up
# Test the affected application path and access policies locally.
# Within the project's deployment authority, target the verified linked project:
supabase db push
```

`sync` compares files with migration history, not live edits. Without explicit
apply flags, non-interactive sync only writes migrations; do not report them as
applied. Keep DML/backfills in versioned migrations or seed fixtures; schema
diffs cannot capture rows, including Storage bucket rows. Review warnings for
unsupported objects; use versioned migrations for those changes.
[Declarative schema guide](https://supabase.com/docs/guides/local-development/declarative-database-schemas).

`supabase config pull` retrieves project settings; `supabase pull` retrieves
config, schema and Edge Functions together. Review the resulting repository
diff before committing. [Announcement](https://supabase.com/blog/select-2026-build-anything).
Use `env(...)` references for secrets and exclude `.env` from Git.
[Config/secrets guide](https://supabase.com/docs/guides/local-development/managing-config).

## Experimental local stacks

Requires **CLI 2.119.0+** and opt-in; merge into the existing TOML table:

```toml
[experimental]
stack = true
```

Alternatively use `SUPABASE_EXPERIMENTAL_STACK=1` for the intended invocation.
The flag redirects local commands to experimental stacks whose data is separate
from legacy stacks. Identity includes project root, git branch and optional
`--stack` name. Separate worktrees isolate agents; two agents in the same checkout
and branch share the default stack. Fixed ports in config still conflict; use
the official port-removal checklist and obtain actual endpoints from `status`.

```bash
supabase stack --help
supabase start --runtime docker
supabase status
supabase stack list
```

Named stacks need explicit targeting: database/migration commands do not accept
`--stack`; where supported, supply the named stack's database URL via `--db-url`.
`db pull`, `db push` and `db dump` default to the linked remote unless given a
local target. Never assume a running test stack selects the command target.
Stopping retains data; destroying deletes database data without backup.
[Multiple-project guide](https://supabase.com/docs/guides/local-development/running-multiple-local-projects).

Prefer Docker/Podman when available, especially for concurrent stacks. Native
is intended for environments without containers; services share host resources.
Supported native hosts are Linux amd64/arm64 (glibc 2.35+) and Apple-silicon macOS
14+, not native Windows. A compatible WSL Linux environment is a separate case.
With experimental stacks enabled, `supabase start --runtime native` selects it.
Runtime choice persists; the CLI does not convert existing data between runtimes.
[Runtime guide](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes).

**DevFlow consequence:** Docker-name scanning is not evidence that a new stack
is backed up. Keep the first trial disposable. Valued native/experimental data
needs runtime-aware discovery, a compatible PostgreSQL dump/restore route, and
Storage file coverage verified before relying on it. Do not reset or destroy a
valued stack to follow an upstream quickstart.

## An MCP server for your app

This serves product users; the official Supabase development MCP serves builders.
Install the app block into the intended repository:

```bash
npx shadcn@latest add @supabase/mcp-server
```

[Announcement and installation](https://supabase.com/blog/select-2026-build-anything).

The block requires **CLI 2.117.0+** and asymmetric JWT signing (ES256/RS256).
Legacy HS256 is rejected. It sets `[functions.mcp] verify_jwt = false` because
`withSupabase({ auth: 'user' })` verifies tokens inside the function. Retain that
verification and the RLS-scoped client; never substitute an admin client.

External clients need the OAuth Consent block, Auth OAuth server enabled, a
matching consent path/Site URL, and HTTPS in production. Choose dynamic client
registration deliberately. Embedded trusted backends can forward the user's
existing access token; keep tokens out of prompts and model-provider payloads.

OAuth scopes do not authorize database rows or business operations. Test tools
with two users and an unauthenticated request. The pipeline composition is alpha;
the nested middleware form is documented as stable. Check Deno function code
separately from frontend TypeScript.
[App MCP guide](https://supabase.com/library/docs/headless/mcp).

## Supabase Compute

**Private alpha/waitlist** at verification. It offers long-lived Linux services
beside the database, with public HTTP or private worker deployment. Consider it
for an always-running worker that does not fit Edge Functions, once access and
costs are confirmed. Availability does not imply a self-hosted replacement for
our existing services. [Announcement](https://supabase.com/blog/select-2026-build-anything),
[Compute access](https://supabase.com/compute).
