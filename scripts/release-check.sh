#!/bin/bash
# Release check: run it on a clean clone of main before anyone tags a version. Read-only.
#   scripts/release-check.sh            check the version in package.json
# It never tags, pushes or publishes. A person with the owner's yes does that after a pass.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0; warn=0
ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; fail=1; }
note() { echo "  warn  $*"; warn=1; }

VERSION=$(node -p "require('./package.json').version")
echo "Release check for version $VERSION ($(git rev-parse --short HEAD), $(date -u +%Y-%m-%d))"

echo "Repository state"
[ "$(git branch --show-current)" = main ] && ok "on main" || bad "not on main"
[ -z "$(git status --porcelain)" ] && ok "working tree is clean" || bad "uncommitted changes"
git fetch -q origin main 2>/dev/null
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main 2>/dev/null)" ] && ok "same commit as origin/main" || bad "not the same commit as origin/main"
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && bad "tag v$VERSION already exists" || ok "tag v$VERSION is free"

echo "Files a public project needs"
for f in LICENSE NOTICE README.md SECURITY.md CONTRIBUTING.md CODE_OF_CONDUCT.md CHANGELOG.md THIRD_PARTY_NOTICES.md .github/CODEOWNERS .github/pull_request_template.md; do
  [ -f "$f" ] && ok "$f" || bad "missing $f"
done
[ -d .github/ISSUE_TEMPLATE ] && ok ".github/ISSUE_TEMPLATE" || bad "missing .github/ISSUE_TEMPLATE"
if [ -f CHANGELOG.md ]; then
  grep -q -E "^#+ .*\[?v?${VERSION//./\\.}\]?" CHANGELOG.md && ok "CHANGELOG has a section for $VERSION" || bad "CHANGELOG has no section for $VERSION"
fi
grep -q 'Apache License' LICENSE 2>/dev/null && ok "licence is Apache 2.0" || bad "LICENSE is not Apache 2.0"

echo "Nothing private in the repository"
if command -v gitleaks >/dev/null; then
  gitleaks detect --no-banner --redact >/dev/null 2>&1 && ok "gitleaks: no leaks in full history" || bad "gitleaks found something"
else note "gitleaks not installed, history not scanned here"; fi
python3 -I scripts/check-public-docs.py >/dev/null 2>&1 && ok "public docs: links and private strings" || bad "public docs check failed"

echo "Dependencies"
if [ -d node_modules ]; then
  a=$(npm audit --omit=dev --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s).metadata.vulnerabilities;console.log((v.high||0)+(v.critical||0))}catch(e){console.log("x")}})')
  [ "$a" = 0 ] && ok "npm audit: no high or critical (production)" || bad "npm audit: high or critical = $a"
else note "node_modules missing, run npm ci first for the audit"; fi

echo "CI on this exact commit"
sha=$(git rev-parse HEAD)
c=$(gh api "repos/Liam-labs/openflow-ai/commits/$sha/check-runs" --jq '[.check_runs[]|select(.name=="checks")|.conclusion]|first' 2>/dev/null)
[ "$c" = success ] && ok "checks: success" || bad "checks on $sha: ${c:-no run found}"
for n in mac smoke; do
  c=$(gh api "repos/Liam-labs/openflow-ai/commits/$sha/check-runs" --jq "[.check_runs[]|select(.name|startswith(\"$n\"))|.conclusion]|unique|join(\",\")" 2>/dev/null)
  [ "$c" = success ] && ok "$n: success" || bad "$n on $sha: ${c:-no run found}"
done

echo "Release artefacts (not required for 0.1)"
[ -f docs/RELEASING.md ] && ok "docs/RELEASING.md" || note "no docs/RELEASING.md (release steps)"
note "signed tags, signed images and reproducible builds are not checked: they do not exist yet"

if [ "$fail" = 0 ]; then [ "$warn" = 1 ] && echo "RELEASE CHECK PASSED (with warnings)" || echo "RELEASE CHECK PASSED"; else echo "RELEASE CHECK FAILED"; fi
exit "$fail"
