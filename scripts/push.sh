#!/bin/sh
# Push (and optionally fetch) via the gh-credential recipe — the reliable
# path under this repo's auth setup: the SSH agent is often unavailable
# (agent forwarding flakes / keys absent), and a stray GH_TOKEN in the env
# shadows `gh auth git-credential`. Unset the token, let gh supply fresh
# credentials, push straight to the HTTPS URL.
#
# Usage: scripts/push.sh [refs...]     (default: main)
#        scripts/push.sh --fetch       (sync origin/main tracking ref only)
#
# The release script has always pushed this way; this wrapper makes the
# manual case one command instead of re-deriving the recipe.
#
# FORKS: the target is named literally, so running this from a fork pushes the
# fork's commits into upstream. The guard below stops that. On a fork the right
# command is the boring one — `git push origin <ref>`.

set -eu

SCRIPT_DIR=$( # shellcheck disable=SC1007
  CDPATH= cd -- "$(dirname -- "$0")" && pwd
)
ROOT="$SCRIPT_DIR/.."
. "$SCRIPT_DIR/guard-upstream.sh"

guard_not_a_fork "$ROOT" || exit 1
REPO_URL="https://github.com/$UPSTREAM_REPO"

if [ "${1:-}" = "--fetch" ]; then
  # Note what this actually does: it writes the upstream main into THIS
  # checkout's `origin/main` tracking ref. Correct in an upstream clone, where
  # origin is upstream; wrong anywhere else, because it silently redefines what
  # "ahead/behind origin" means. The guard above is what keeps it honest.
  exec env -u GH_TOKEN git -c credential.helper='!gh auth git-credential' \
    fetch "$REPO_URL" +refs/heads/main:refs/remotes/origin/main
fi

REFS="${@:-main}"
exec env -u GH_TOKEN git -c credential.helper='!gh auth git-credential' \
  push "$REPO_URL" $REFS
