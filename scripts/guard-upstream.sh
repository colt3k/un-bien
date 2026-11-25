#!/bin/sh
# guard-upstream.sh — stop a fork from publishing into the repository the
# publishing scripts were written for.
#
# push.sh and release.sh name their target LITERALLY rather than reading
# `origin`, because upstream's auth setup needs the gh-credential recipe
# against a known HTTPS URL (SSH agent forwarding flakes; a stray GH_TOKEN
# shadows `gh auth git-credential`). That is correct upstream and dangerous
# anywhere else. This checkout may be a fork — `colt3k/un-bien` is one — and a
# fork running either script would push its own commits into someone else's
# repository, with release.sh also pushing the tags that trigger the
# npm / crates.io / Homebrew publishes.
#
# Source it, then call the guard:
#
#   . "$SCRIPT_DIR/guard-upstream.sh"
#   guard_not_a_fork "$ROOT" || exit 1
#
# The expected upstream is `georgeharker/un-bien`. Set UNBIEN_UPSTREAM_REPO to
# publish somewhere else deliberately — the override both passes the guard and
# (in push.sh) becomes the URL pushed to, so there is one knob, not two.
#
# ASCII-only on purpose: /bin/sh is bash 3.2 (see build-iphone.sh).

UPSTREAM_REPO="${UNBIEN_UPSTREAM_REPO:-georgeharker/un-bien}"

# guard_not_a_fork [repo-dir]
#   0 — origin IS the expected upstream, publishing is intended.
#   1 — origin is something else (a fork, or absent). Nothing was sent.
guard_not_a_fork() {
  root="${1:-.}"
  origin_url=$(git -C "$root" remote get-url origin 2>/dev/null || true)

  case "$origin_url" in
    *"$UPSTREAM_REPO"*) return 0 ;;
  esac

  # Echo the origin WITHOUT its credentials. A fork's origin often carries a
  # token in the URL (this repo's does), and printing it to name the remote
  # would put a secret in terminal scrollback and in whatever captured the run.
  shown=$(printf '%s' "$origin_url" | sed -e 's#://[^/@]*@#://#')

  echo "refusing: this script publishes to $UPSTREAM_REPO." >&2
  echo "  this checkout's origin is: ${shown:-<none>}" >&2
  echo "  push a fork with: git push origin <ref>" >&2
  echo "  to publish elsewhere on purpose: UNBIEN_UPSTREAM_REPO=<owner>/<repo>" >&2
  return 1
}
