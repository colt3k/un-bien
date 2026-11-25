#!/usr/bin/env bash
#
# guard-upstream.test.sh — the fork guard behind scripts/push.sh and
# scripts/release.sh.
#
# What is worth testing is the decision, not the push. Both scripts name their
# target LITERALLY (upstream's auth setup needs the gh-credential recipe
# against a known HTTPS URL), so a fork that runs either one pushes its own
# commits — and in release.sh's case the tags that publish the npm packages,
# the crate and the formula — into the repository it was forked from. The guard
# must refuse that, and must NOT refuse the same script run in an upstream
# clone, or the guard gets worked around.
#
# Nothing here touches the network: the allow cases exercise the guard
# function, and the one script invoked end-to-end (push.sh) is invoked in a
# temp repo whose origin cannot be reached, asserting it stopped at the guard.
#
# Run: scripts/guard-upstream.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/guard-upstream.sh"
PUSH="$HERE/push.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/guard-upstream-test-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
# Same guard revoke-peer.test.sh learned to carry: everything written sits under
# the temp root, resolved for symlinks (/var <-> /private/var on macOS).
case "$TMP" in
  /*) : ;;
  *) printf 'mktemp gave a relative path: %s\n' "$TMP" >&2; exit 1 ;;
esac
want="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
got="$(cd "$TMP" 2>/dev/null && pwd -P || true)"
[[ -n "$got" ]] || { printf 'mktemp path vanished: %s\n' "$TMP" >&2; exit 1; }
case "$got" in
  "$want"/*) : ;;
  *) printf 'refusing to write outside the temp root: %s (not under %s)\n' "$got" "$want" >&2; exit 1 ;;
esac

pass=0
fail=0
ok() {
  pass=$((pass + 1))
  printf '  ok   %s\n' "$1"
}
no() {
  fail=$((fail + 1))
  printf '  FAIL %s\n' "$1"
  [[ -n "${2:-}" ]] && printf '       %s\n' "$2"
}

# shellcheck disable=SC1090
. "$GUARD"

# A repo whose origin is $2, with nothing in it.
mk_repo() {
  local dir="$1" url="$2"
  git init -q "$dir" >/dev/null || return 1
  git -C "$dir" remote add origin "$url"
}

printf 'guard: origin is what the script was written for\n'

for url in \
  "https://github.com/georgeharker/un-bien" \
  "https://github.com/georgeharker/un-bien.git" \
  "git@github.com:georgeharker/un-bien.git"
do
  repo="$TMP/allow-$$-$RANDOM"
  mk_repo "$repo" "$url"
  if guard_not_a_fork "$repo"; then
    ok "allows $url"
  else
    no "allows $url" "guard refused an upstream clone"
  fi
  rm -rf "$repo"
done

printf 'guard: origin is a fork, or absent\n'

# This repo's real origin shape: a fork, with credentials embedded in the URL.
repo="$TMP/fork-https"
mk_repo "$repo" "https://someone:ghp_xxxxxxxxxxxx@github.com/someone/un-bien.git"
out=$(guard_not_a_fork "$repo" 2>&1)
rc=$?
if [[ $rc -ne 0 ]] && grep -q 'refusing:' <<<"$out"; then
  ok "refuses a fork over https"
else
  no "refuses a fork over https" "rc=$rc out=$out"
fi
grep -q 'git push origin' <<<"$out" &&
  ok "names the command a fork should use instead" ||
  no "names the command a fork should use instead" "$out"
# The origin URL carries a token in the common setup; naming the remote must
# not print the secret into the terminal (or into a captured run).
grep -q 'ghp_xxxxxxxxxxxx' <<<"$out" &&
  no "keeps the token out of the refusal" "$out" ||
  ok "keeps the token out of the refusal"
grep -q 'github.com/someone/un-bien.git' <<<"$out" &&
  ok "still names the remote, credentials stripped" ||
  no "still names the remote, credentials stripped" "$out"
rm -rf "$repo"

repo="$TMP/fork-ssh"
mk_repo "$repo" "git@github.com:someone/un-bien.git"
guard_not_a_fork "$repo" >/dev/null 2>&1 &&
  no "refuses a fork over ssh" "guard allowed it" ||
  ok "refuses a fork over ssh"
rm -rf "$repo"

repo="$TMP/no-origin"
git init -q "$repo" >/dev/null
out=$(guard_not_a_fork "$repo" 2>&1)
rc=$?
if [[ $rc -ne 0 ]] && grep -q '<none>' <<<"$out"; then
  ok "refuses a checkout with no origin"
else
  no "refuses a checkout with no origin" "rc=$rc out=$out"
fi
rm -rf "$repo"

printf 'guard: the override is deliberate, and single\n'

repo="$TMP/override"
mk_repo "$repo" "https://github.com/other/mirror.git"
out=$(
  UNBIEN_UPSTREAM_REPO="other/mirror"
  # shellcheck disable=SC1090
  . "$GUARD"
  guard_not_a_fork "$repo" 2>&1
)
[[ $? -eq 0 ]] && ok "UNBIEN_UPSTREAM_REPO lets a deliberate target through" ||
  no "UNBIEN_UPSTREAM_REPO lets a deliberate target through" "$out"
rm -rf "$repo"

printf 'push.sh: stops before the push, in a fork\n'

# End-to-end, in a throwaway repo so the real checkout is never involved. The
# origin is unreachable on purpose: reaching the network would itself be the
# failure, and the assertion is that the refusal text is what comes back.
fork="$TMP/push-fork"
git init -q "$fork" >/dev/null
mkdir -p "$fork/scripts"
cp "$GUARD" "$PUSH" "$fork/scripts/"
git -C "$fork" remote add origin "https://127.0.0.1:1/not-the-upstream.git"
out=$(cd "$fork" && sh scripts/push.sh main 2>&1)
rc=$?
if [[ $rc -ne 0 ]] && grep -q 'refusing: this script publishes to' <<<"$out"; then
  ok "push.sh refuses instead of pushing"
else
  no "push.sh refuses instead of pushing" "rc=$rc out=$out"
fi
grep -qi 'could not read\|failed to connect\|fatal: remote' <<<"$out" &&
  no "push.sh never reached the network" "$out" ||
  ok "push.sh never reached the network"
rm -rf "$fork"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]] || exit 1
