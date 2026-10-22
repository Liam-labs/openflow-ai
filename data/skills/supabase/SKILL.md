---
name: supabase
description: >
  Working guide for Supabase: Auth, RLS, Postgres, Data API, Storage, Realtime, Edge Functions, migrations, declarative schemas, config in code, local stacks, app MCP servers, Compute availability and backups. Use for Supabase implementation, debugging or review.
---
# Supabase

This skill covers every Supabase platform layer: Auth, Data API (PostgREST), Postgres + RLS, Storage, Realtime, Edge Functions, Management API, CLI/migrations, and observability.

Treat official docs (`supabase.com/docs`) as source of truth. Verify assumptions before acting — Supabase ships changes often.

**Reference documentation:** `~/.claude/docs/supabase-reference.md` — read when you need longer syntax, code samples, framework-specific patterns, or full migration workflows.

**October 2026 workflows:** Read [Agent development, declarative schemas and app MCP](references/agent-development.md) when using `pg-delta`, config pull, experimental local stacks, an app's own MCP endpoint, or Supabase Compute. It contains current prerequisites, commands and adoption limits. Check the actual project's CLI version and config first; an announcement does not upgrade an existing installation.

**Adopted development default (owner decision, 7 October 2026):** For new projects, keep config and declarative SQL in the repo, generate reviewed migrations with `pg-delta`, apply/test locally, then deploy within the project's authority. The desktop CLI is now 2.120.0. Preserve existing projects' migration history when adopting this workflow. Enable experimental stacks per disposable project, never through a machine-wide environment setting; see the reference for the desktop's tested paths and current startup limitation.

---

## Operating Principles

### 1) Understand before acting

1. Identify the failing layer (see Layer Model)
2. Verify auth context (session, user, JWT claims, email/phone confirmation, anonymous vs permanent)
3. Read existing code, migrations, and config first
4. Check project settings/advisors if accessible
5. Form a single hypothesis before changing anything

Do not enter a "try random fix → fail → try random fix" loop. Three failed attempts ≠ keep trying — stop and re-diagnose.

### 2) Test at the right layer

- Prefer the official Supabase client SDK when debugging session refresh, SSR cookies, PKCE flows, and token storage.
- `curl` is still valid for **API-layer isolation** — confirming PostgREST filters, checking Management API endpoints, reproducing a raw HTTP bug.
- Do not rely on `curl` alone for client-auth-flow bugs — it bypasses session management, cookie handling, and refresh logic.

### 3) Debug bottom-up

Validate lower layers before higher:

1. Postgres objects + GRANTs
2. RLS policies
3. API behavior (PostgREST / Auth / Storage / Realtime endpoints)
4. SDK / session lifecycle
5. App / framework integration

### 4) Backups are part of "done" for any local self-hosted stack (MANDATORY)

Whenever you set up, review, or touch **any** local self-hosted Supabase project (docker-compose, `supabase_db_*` container), **backup wiring is required before "done"** — not optional, not a follow-up. `neurostride-local` slipped through precisely because it was never added to the manual registry, so nothing backed it up. Required pattern (full detail + scripts in `~/.claude/docs/supabase-reference.md`):

- **Discover dynamically** — `docker ps --format '{{.Names}}' | grep '^supabase_db_'`. NEVER a hand-maintained registry JSON; that omission caused the miss.
- **Dump** via `docker exec <container> pg_dump -U postgres -Fc -d postgres` for BOTH daily-full and hourly. NOT `supabase db dump` (see Common Error Patterns).
- **Write to** `~/DevFlow/.AppData/supabase-backups/<slug>/{daily,hourly}/` — under the home folder, so structurally covered by the file backup.
- **Verify — never trust exit 0.** Confirm rows: `docker exec -i <container> pg_restore -l < <dump> | grep -c 'TABLE DATA'` (host has no `pg_restore`; use the container's). Exit 0 with zero table data is a silent failure.

These discovery commands cover our existing Docker stacks. Experimental native stacks have no container to discover, and experimental Docker stacks must not be assumed to match the old naming pattern. Before retaining valued data in either, verify backup discovery and restore coverage for that runtime; see the October reference. Disposable test stacks should be reproducible from migrations and fixtures.

---

## Layer Model

```
Layer 7  Application framework   Next.js / SvelteKit / Nuxt / Remix
Layer 6  Supabase client SDK     session lifecycle, retries, token storage, SSR cookies
Layer 5  Supabase APIs           PostgREST, Auth (GoTrue), Storage, Realtime endpoints
Layer 4  Edge Functions          JWT verification, secrets, service-role usage
Layer 3  RLS policies + grants   USING / WITH CHECK, permissive vs restrictive, GRANT/USAGE
Layer 2  Postgres objects        tables, views, functions, triggers, indexes, extensions
Layer 1  Project config          Auth/PostgREST/Storage/Realtime settings, rate limits, compute
```

---

## Auth

### API Key Model (current, 2025+)

Supabase is migrating from JWT-based legacy keys to non-JWT API keys:

| Old (legacy JWT) | New | Use |
|---|---|---|
| `anon` | `sb_publishable_...` | Client-side, browser, mobile |
| `service_role` | `sb_secret_...` | Server-side only |

Key facts (verify current status via the API Keys guide before production cutover):

- Legacy `anon` / `service_role` keys still work during transition — both models can coexist.
- `sb_secret_...` keys include browser detection — return HTTP 401 automatically if they reach a browser.
- Migration path: create new keys in Dashboard → rotate clients → watch last-used indicators → deactivate legacy once traffic has moved.
- Docs language has shifted to "will be deprecated shortly" — treat legacy keys as end-of-life.

**Never expose secret keys** (legacy or new) to frontend bundles, browser env vars, logs, or Git history. RLS is enforced on publishable/anon keys; service/secret keys bypass RLS entirely.

### signUp() session behavior

| Email confirmation | `data.user` | `data.session` |
|---|---|---|
| Enabled (default) | user | **null** |
| Disabled (`mailer_autoconfirm=true`) | user | session |

This is the #1 source of "RLS error immediately after signup" bugs: confirmation on → no session → `auth.uid()` is null → write fails.

Fixes:

1. Disable email confirmation in dev (Dashboard → Auth → Settings)
2. Provision initial rows via a `SECURITY DEFINER` trigger on `auth.users` (runs as admin, bypasses RLS)
3. Defer writes until after `signInWithPassword()` once confirmed

### Session settings (Pro+)

- **Time-boxed sessions** — fixed max lifetime
- **Inactivity timeout** — enforced at refresh time, not proactively
- **Single session per user** — only the latest sign-in stays active
- **Refresh token rotation** — one-time-use; 10s reuse window; unauthorized reuse revokes the session family

### PKCE vs implicit flow

- Defaults differ per SDK: JS/Dart → implicit, Swift → PKCE.
- **Use PKCE for any SSR / server-rendered app.** If you're using `@supabase/ssr`, you're using PKCE.
- Implicit flow only fits pure client-only apps (token delivered in URL fragment).

### Anonymous users

- `supabase.auth.signInAnonymously()` creates an `authenticated` user with `is_anonymous: true` JWT claim.
- Link to permanent: `updateUser({ email })` or `linkIdentity()`. Email/phone verification required before adding a password.
- **RLS implication:** permissive policies combine with OR. To deny anonymous users access to sensitive rows, add a **restrictive policy**:
  ```sql
  CREATE POLICY "deny anonymous" ON sensitive_table
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING ((auth.jwt() ->> 'is_anonymous')::boolean = false);
  ```
- Rate-limit anonymous sign-in (default 30/hr) and/or gate with CAPTCHA.

### Server-side auth trust model

For authorization decisions on the server, **prefer server-verified identity**:

- `getUser()` — hits Auth server, validates JWT, confirms session is still live. Safe for authz.
- `getClaims()` — local JWT verification (signature + expiry). Fast, but does **not** confirm the session hasn't been revoked server-side.
- `getSession()` — storage-only read. Fast, can return stale/tampered data. Use only when you explicitly accept its trust model (e.g. UI hints, non-security-critical paths).

"The only way to confirm a session is genuinely still valid is `getUser()`."

### `@supabase/ssr` (stable)

Officially replaces the deprecated `@supabase/auth-helpers-*` packages — uninstall auth-helpers if present. No longer beta.

Next.js App Router canonical pattern:

```ts
// server client
createServerClient(url, key, {
  cookies: {
    getAll: () => cookieStore.getAll(),
    setAll: (cookies) => cookies.forEach(({ name, value, options }) =>
      cookieStore.set(name, value, options))
  }
})
```

Middleware must call `supabase.auth.getUser()` to refresh tokens; don't skip this or sessions expire client-side.

### `onAuthStateChange` callback pitfall

Known deadlock: awaiting any `supabase.*` method **inside** the callback can hang subsequent Supabase calls on that client.

Guidance:

- Do not make the callback `async`
- Do not `await` supabase-js calls inside it
- Defer real work with `setTimeout(fn, 0)` or a queue external to the callback

Events: `INITIAL_SESSION`, `SIGNED_IN`, `SIGNED_OUT`, `TOKEN_REFRESHED`, `USER_UPDATED`, `PASSWORD_RECOVERY`, `MFA_CHALLENGE_VERIFIED`.

---

## RLS and Postgres Privileges

### USING vs WITH CHECK

| Clause | Commands | Purpose |
|---|---|---|
| `USING` | SELECT, UPDATE, DELETE | Filter which existing rows are visible/affected |
| `WITH CHECK` | INSERT, UPDATE | Validate the new/modified row data |

**INSERT requires `WITH CHECK`, not `USING`:**

```sql
-- WRONG - always fails
CREATE POLICY ... ON t FOR INSERT USING (user_id = auth.uid());
-- CORRECT
CREATE POLICY ... ON t FOR INSERT WITH CHECK (user_id = auth.uid());
```

UPDATE uses both: `USING` filters which rows the user can see; `WITH CHECK` validates the new state.

### `auth.uid()` returns NULL when

- No Authorization header on the request
- JWT expired or malformed
- Email not yet confirmed (no session exists)

Explicit null-safe form (the Advisors lint prefers this):

```sql
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = user_id)
```

The `(SELECT auth.uid())` wrapper caches the function result per query instead of re-evaluating per row — significant perf win on large scans.

### Permissive vs Restrictive policies

- Default = **PERMISSIVE** — multiple policies for the same role/command combine with **OR**. Any policy granting access is enough.
- **RESTRICTIVE** policies combine with **AND** — every matching restrictive policy must pass.

Use restrictive policies to enforce **hard blocks** on top of permissive allows (e.g. "anonymous users can never read this", "deleted_at IS NULL").

### UPDATE requires SELECT visibility

Postgres must SELECT a row before it can UPDATE it. An UPDATE policy without a matching SELECT policy silently updates zero rows. Always grant SELECT (scoped if needed).

### RLS + GRANTs together

RLS does **not** replace SQL privileges. Both must be correct:

- `GRANT USAGE ON SCHEMA public TO authenticated, anon;`
- `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE t TO authenticated;`
- Policies scoped with `TO authenticated` to avoid silently covering `anon` too

### Testing RLS safely in SQL

```sql
SET ROLE authenticated;
SET request.jwt.claims = '{"sub":"<user-uuid>","role":"authenticated"}';
-- Run the failing operation
RESET ROLE;
```

For anonymous, set `"is_anonymous": true` in claims.

### Foreign keys to `auth.users`

Only reference the primary key:

```sql
user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
```

Never reference mutable columns (`email`, etc.).

### Auto-create profile trigger

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data ->> 'full_name');
  RETURN NEW;
END; $$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

A failing trigger blocks signups — test error paths thoroughly, keep logic minimal.

### SECURITY DEFINER hygiene

- Prefer `SECURITY INVOKER` as default
- When `SECURITY DEFINER` is required: always `SET search_path = ''` and fully schema-qualify every reference (`public.profiles`, not `profiles`)
- Avoid dynamic SQL inside definer functions
- Minimize the body — definer privilege is powerful

---

## Data API (PostgREST)

### ⚠️ BREAKING: Explicit GRANTs becoming mandatory (May 2026)

Supabase is locking down Data API access to `public` schema tables. **New projects from 30 May 2026** and **all projects from 30 October 2026** will NOT auto-expose tables in `public` to the Data API. Every table that needs supabase-js, PostgREST, or GraphQL access requires an explicit `GRANT` in migrations or provisioning scripts.

Direct-connection access (psql, ORMs, connection strings) is unaffected — this only applies to the Data API layer.

**Required GRANT pattern per role:**

```sql
GRANT SELECT ON public.your_table TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.your_table TO service_role;

ALTER TABLE public.your_table ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users can read their own rows"
  ON public.your_table
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
```

**Missing GRANT error:** PostgREST returns HTTP **42501** with the exact `GRANT` statement needed to fix it. The error message includes the full SQL — copy it and run it, or better, add it to your migration.

**Migration checklist for existing projects (before Oct 30):**
1. Audit all `public` tables accessed via Data API
2. Add explicit GRANTs for `anon`, `authenticated`, `service_role` as needed
3. Verify RLS is enabled on every Data-API-facing table
4. Add policies matching your access patterns

- Base: `https://<ref>.supabase.co/rest/v1/`
- Each request resolves to a single SQL statement
- RPC: `POST /rest/v1/rpc/<function_name>`
- `public` schema exposed by default (until the above dates); expose other schemas via Dashboard or Management API
- Filters, ordering, pagination, embeds — use SDK query builder or read the PostgREST reference

### Management API knobs

`PATCH /v1/projects/{ref}/postgrest` exposes:

- `max_rows` — row cap per request
- `db_schema` — exposed schema list
- `db_extra_search_path`
- `db_pool` — connection pool size

Pair with `GET /v1/projects/{ref}/postgrest` to read current config.

### Embedded resources gotcha

Embedded queries (`.select('*, related(*)')`) generate LEFT JOINs and apply RLS on each relation. An empty embedded array often means "RLS denied on the joined table", not "no rows" — check the Advisors lint.

---

## Storage

`storage.objects` and `storage.buckets` have RLS enabled by default. No policies = no access.

### Bucket privacy

| Public | Private |
|---|---|
| Anyone with URL can GET | All reads require auth |
| Better CDN caching | Reads via authenticated download or signed URLs |
| Writes/deletes still RLS-protected | Writes/deletes RLS-protected |

### Signed URLs vs public URLs

- **Public bucket** → use `getPublicUrl()` (cached at edge)
- **Private bucket** → use `createSignedUrl(path, expiresIn)` (time-limited access token in URL)
- Never commit signed URLs to logs or monitoring — they're single-user credentials

### Upload APIs

| API | Best for | Limit |
|---|---|---|
| Standard `upload()` | ≤6 MB | 5 GB hard cap |
| TUS resumable | Large / flaky network | 50 GB (tier-dependent) |
| S3-compatible endpoint | Existing S3 tooling | Plan-dependent |

`upsert: true` to overwrite; default rejects duplicates with HTTP 400.

### Storage debug order

1. Is the bucket public or private? Does that match intent?
2. Does `storage.objects` have a matching policy for the current role + command?
3. Is the user authenticated when required?
4. Is `owner` set correctly on the object (owner-based policies rely on it)?
5. Does `content-type` pass any `metadata` check in the policy?

---

## Realtime

Three modes — don't conflate them:

| Mode | What it does | Setup |
|---|---|---|
| **Broadcast** | Low-latency pub/sub messages | Channel-scoped, no DB involvement |
| **Presence** | Shared state / who-is-here | Built on Broadcast |
| **Postgres Changes** | Row-level DB change stream | Requires publication config |

### Postgres Changes setup

Tables must be in the `supabase_realtime` publication:

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
```

Or Dashboard → Database → Publications. RLS policies are evaluated per event before delivery — if the subscriber can't SELECT the row, they don't see the change.

### Channel authorization

For private channels:

```js
const channel = supabase.channel('room:1', { config: { private: true } })
```

- Clients must be authenticated
- Policies on `realtime.messages` control read/broadcast/presence access
- Policies are cached for the connection lifetime — reconnect to pick up policy changes
- Disable "Allow public access" in Dashboard → Realtime → Settings to enforce private-only

### Debug order

1. Correct mode (Broadcast vs Postgres Changes)?
2. Table in `supabase_realtime` publication? (for Postgres Changes)
3. Does the subscriber have SELECT via RLS on the target row?
4. Is the channel private/public as intended?
5. Reconnection lifecycle — is the client re-subscribing on reconnect?

---

## Edge Functions

### JWT verification default

Default: JWT verification **on** at the gateway. Disable per function in `supabase/config.toml`:

```toml
[functions.webhook-receiver]
verify_jwt = false
```

Or CLI: `supabase functions deploy webhook-receiver --no-verify-jwt`.

Disable for public endpoints, webhooks with their own signature verification, or authenticated functions that verify user tokens inside the function. The official app MCP block uses the last pattern: `verify_jwt = false` plus `withSupabase({ auth: 'user' })`; disabling the gateway check alone does not authenticate requests. See [app MCP prerequisites](references/agent-development.md#an-mcp-server-for-your-app).

### Service role usage

Only inside Edge Functions, server code, or trusted backends. Never ship to the client. Use sparingly — prefer RLS-safe queries where possible.

### Secrets

```ts
const apiKey = Deno.env.get('STRIPE_SECRET_KEY')
```

Built-ins injected automatically:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (legacy — migrating to publishable)
- `SUPABASE_SERVICE_ROLE_KEY` (legacy — migrating to secret)

Set custom secrets: `supabase secrets set NAME=value` or Dashboard.

### Debug order

1. Function logs (Dashboard → Edge Functions → `<fn>` → Logs)
2. API gateway logs
3. Downstream Postgres / external service logs
4. Cold start? → watch latency traces
5. Region mismatch? → check the function's region vs where the caller is

---

## Management API

Base: `https://api.supabase.com/v1/` · Auth: `Authorization: Bearer <PAT or OAuth token>`

Essential endpoints:

| Endpoint | Purpose |
|---|---|
| `GET/PATCH /v1/projects/{ref}/postgrest` | Data API config |
| `GET/PATCH /v1/projects/{ref}/config/auth` | Auth config (SMTP, providers, session settings) |
| `GET/PATCH /v1/projects/{ref}/storage` | Storage config |
| `POST /v1/projects/{ref}/database/query` | Ad-hoc SQL (careful) |
| `GET/POST /v1/projects/{ref}/upgrade` | Compute sizing + eligibility |
| `GET /v1/projects/{ref}/advisors/{security,performance}` | Lints |
| `GET /v1/projects/{ref}/analytics/endpoints/logs.all` | Log search (+ per-service variants) |

Endpoint shapes move — always verify against the live reference at `supabase.com/docs/reference/api/introduction` before coding.

---

## Advisors (Security + Performance lints)

Run before every production deploy.

**Security**: tables without RLS · RLS enabled but no policies · SECURITY DEFINER views/functions without locked search_path · exposed `auth` schema · mutable-function search_path · extension in `public` · leaked-password-protection off · insufficient MFA options

**Performance**: unindexed foreign keys · unused indexes · duplicate indexes · `auth.<fn>()` inside row context without `(select …)` wrapper · multiple permissive policies on same role/action

Access via Dashboard → Advisors or Management API.

---

## CLI + Migrations

Keep deployment history in `supabase/migrations/`. With declarative schemas, edit schema files and generate that history; otherwise retain the project's existing migration workflow. Reconcile Dashboard changes into the repo.

Read [the October reference](references/agent-development.md#declarative-schemas-and-config-in-code) before changing engines. `pg-delta` uses `db schema declarative sync` for schema files; its `db diff` reads the live database. Legacy `migra` changes `db diff` behavior when declarative files exist. Do not mix those workflows.

```bash
supabase init                              # scaffold
supabase link --project-ref <ref>          # bind to remote
supabase migration new add_profiles        # empty file in supabase/migrations/
supabase db pull                           # introspect remote → migration capturing drift
supabase db push                           # apply local migrations to linked remote
supabase db diff -f generated_name         # live diff; see engine/declarative caveat above
supabase gen types typescript --linked > types.ts
```

### `supabase db reset` — destructive

- **Local** (default): drops the container, reapplies everything in `supabase/migrations/`, runs `supabase/seed.sql` if present. Local data is wiped.
- **Remote** (`--linked` / `--db-url`): drops all user-created entities on the remote DB and reapplies migrations + seed. **Data not in migrations/seed is permanently lost.**

This is banned on remote without the project's safe-reset wrapper (if one exists). Prefer `supabase migration up` to apply pending migrations non-destructively.

### Branching / preview environments

- GitHub integration is GA; Dashboard-managed branches still labeled beta in places — verify current status.
- Preview branches: ephemeral, per-PR. Supabase clones repo → applies migrations → deploys Edge Functions → tears down on merge/close.
- Use for migration rehearsals, schema review, API contract tests.

---

## Observability Runbook

Fixed order when an incident fires:

1. **Reproduce** — get a deterministic repro, ideally with the SDK
2. **Read logs** — Auth logs, API logs, Postgres logs, Function logs (in that order)
3. **Verify policies + grants** — RLS plus SQL privileges; run Advisors
4. **Validate config** — relevant Management API GET endpoint
5. **Apply minimal fix** — one change at a time
6. **Verify with explicit checks** — re-run the repro, run adjacent tests, re-run Advisors

Never "restart and hope". Root cause first.

---

## Rate Limits (defaults, verify against project config)

| Area | Detail |
|---|---|
| Auth | Token-bucket; 30-request bucket cap; per-IP (verify/refresh/MFA/anon), per-user (OTP/signup-confirm/pw-reset), project-wide (built-in SMTP email/hr, OTP/hr). Tunable. |
| Realtime Free | 200 concurrent conns · 100 msg/s · 100 joins/s · 256 KB payload · 20 presence msg/s |
| Realtime Pro | 500 conns · 500 msg/s · 500 joins/s · 3000 KB payload · 50 presence msg/s |
| Data API | No hard per-request rate limit; bounded by compute, egress, `max_rows` |

Auth defaults are now template-driven in the doc — read the project's actual config via Management API for the real numbers.

---

## Production Hardening Checklist

Reference: `supabase.com/docs/guides/platform/going-into-prod`

**Security**
- RLS on every exposed table
- Enforce SSL
- Network restrictions (IP allowlist for admin API)
- MFA on the Supabase account
- Email confirmations on
- OTP expiry ≤3600s
- Custom SMTP (built-in SMTP has tight limits)
- Leaked-password protection on
- Service/secret keys only server-side

**Performance**
- Indexes match query shape — run Advisors
- Wrap `auth.<fn>()` in `(SELECT auth.<fn>())` inside RLS
- k6 or similar load test against a staging branch
- Right-size compute; enable read replicas if needed
- PITR for DBs > 4 GB

**Availability**
- Upgrade off Free (Free pauses after 7 days idle)
- Configure backups + PITR — **applies to local dev / self-hosted stacks too, not just hosted projects.** Every `supabase_db_*` container needs verified daily-full + hourly backups wired before "done" (see Operating Principle 4)
- 2-week notice to Supabase support for expected traffic surges
- Rate-limit tuning + CAPTCHA on public-facing endpoints

---

## Common Error Patterns

| Error | Likely cause |
|---|---|
| `new row violates row-level security policy` | `auth.uid()` is null · INSERT policy using `USING` instead of `WITH CHECK` · predicate mismatch · role not covered |
| `permission denied for table X` | Missing GRANT/USAGE · RLS enabled without matching policy · (new) table created without explicit GRANT after May/Oct 2026 policy change |
| HTTP 42501 from PostgREST | Missing explicit GRANT on `public` schema table — error body includes the exact GRANT statement to run |
| Empty SELECT with known data | RLS mismatch · wrong role/session · restrictive filter |
| Auth 500 / "Database error saving new user" | Failing trigger on `auth.users` · constraint violation in signup transaction |
| HTTP 401 from secret key | Using `sb_secret_*` in a browser (auto-blocked) |
| `supabase-js` call hangs | `await` inside `onAuthStateChange` callback |
| Empty embedded array in PostgREST | RLS denies on the joined relation, not "no rows" |
| Realtime Postgres Changes silent | Table not in `supabase_realtime` publication, or RLS denies the subscriber |
| 429 | Rate limited — implement backoff, check Auth rate limits config |
| Statement timeout | Query needs index / optimization / wrap auth functions |
| Backup "succeeds" (exit 0) but has 0 rows | `supabase db dump` CLI defaults to **schema-only** without `--data-only` — and filters out managed schemas (auth/storage). For local/self-hosted backups use `docker exec <container> pg_dump -Fc` directly; verify with `pg_restore -l \| grep 'TABLE DATA'`. Don't fight the CLI |

---

## Response Format

When debugging or reviewing, structure output under these headings: **Analysis** (layer + hypothesis), **Investigation** (what was checked/found, with SQL/code), **Root Cause** (precise failure point), **Solution** (minimal correct fix — code + SQL), **Verification** (steps that prove the fix works).

Lead with the root cause. Don't narrate alternatives you ruled out unless relevant.

---

## Environment Variables

Available via `~/.secrets`:

- `$SUPABASE_SECRET_KEY` — legacy service-role-equivalent. Server-side only. Reference by variable name, never log the value.

Project-specific keys live in the project's `.env` / `.env.local`.

---


## Labeled as Opinion

Best practice, not universal law — flag when deviating:

- `getUser()` over `getSession()` on the server — correct for authz, but `getSession()` has legitimate fast-path uses.
- "Never use service role outside Edge Functions" — true 99% of the time; batch jobs and trusted workers are exceptions.
- `SECURITY DEFINER` with empty search_path — correct default; deviate only with a stated reason.
- Anonymous-user restrictive policies — recommended; app-layer segregation also works.

When in doubt, check the current doc and Advisors output. Both beat assumption.

---

## Quick Reference

Deep syntax, framework integration (Next.js/SvelteKit/Nuxt), TypeScript type generation, multi-tenant patterns, connection pooling (transaction mode port 6543, session mode, Direct), and the full troubleshooting guide:

**`~/.claude/docs/supabase-reference.md`**

To improve this skill, edit `~/DevFlow/data/skills/supabase/SKILL.md` and redeploy it with `python3 ~/DevFlow/data/scaffolding/sync.py --skills-only --skill supabase`.
