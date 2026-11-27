#!/usr/bin/env bash
# Build the web client WITHOUT blanking the directory a live preview is serving.
#
# WHY THIS EXISTS
# `vite build` empties outDir before writing it. While `vite preview` is serving
# that same dist/, the site has no index.html and no assets for the length of a
# build — a reload in that window 404s. And it is worse than a bad reload: the
# QR decoder is a SEPARATE lazily-imported chunk (src/qr-decode.ts does
# `await import("jsqr")`), so an already-open tab breaks the next time it scans
# a code — its dynamic import asks for the old hashed filename and gets a 404.
# A page the user never reloaded, silently broken. Hit live when a rebuild ran
# against a serving dist/.
#
# start.sh already guards its own preview path (`already_running` exits before
# it would build), so the script never does this to itself. This closes the hole
# for every OTHER way of building: a bare `pnpm build`, CI, or an agent doing
# the obvious thing.
#
# HOW
# Build into a fresh dist.build-<stamp>/, then point the `dist` symlink at it.
# `ln -sfn` is rename(2) on the symlink itself — atomic. A reader sees either
# the whole old build or the whole new one, never a half-written or empty
# directory. The old build is unlinked only AFTER the swap, so a response that
# started before the swap still finds its files.
#
#   scripts/build-swap.sh            # build, swap, drop the old build
#   scripts/build-swap.sh --keep 3   # keep the 3 newest for rollback
#   scripts/build-swap.sh --no-carry # do not carry the previous build's assets
#
# ONE GENERATION OF CARRY-FORWARD.
# Hashed filenames change when content changes. A phone tab that has been open
# since before this rebuild still asks for the OLD names, and it asks LATE —
# jsQR is imported at scan time, not at load time — so a swap that deletes the
# old build silently breaks a page the user never reloaded. The previous build's
# assets are copied into the new one before the old one is deleted, so every
# name that was served stays fetchable for one more generation.
#
# The FIRST run converts a real dist/ directory into the symlink. That one
# conversion has a sub-second window — do it while nothing is serving.
set -euo pipefail

WEB="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP=1
CARRY=1

say()  { printf '   ->   %s\n' "$*"; }
bad()  { printf '   FAIL %s\n' "$*"; }

# Same shape as start.sh's resolver, kept small on purpose: pnpm if installed,
# otherwise a pinned pnpm through npx. `npx` alone would run `npx build`.
pnpm_cmd() {
  if command -v pnpm >/dev/null 2>&1; then echo pnpm; return; fi
  if command -v corepack >/dev/null 2>&1; then echo corepack pnpm; return; fi
  echo "npx pnpm"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="${2:-1}"; shift 2 ;;
    --no-carry) CARRY=0; shift ;;
    -h | --help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) bad "unknown flag: $1"; exit 2 ;;
  esac
done

[[ "$KEEP" =~ ^[0-9]+$ ]] || { bad "--keep wants a number (got: $KEEP)"; exit 2; }

stamp="$(date +%Y%m%d-%H%M%S)-$$"
out="dist.build-$stamp"

say "building into $out/ …"
# shellcheck disable=SC2046  # pnpm_cmd is intentionally word-split ("npx pnpm")
$(pnpm_cmd) -C "$WEB" build --outDir "$out" --emptyOutDir

# The symlink target is relative, so moving the clone does not break it.
if [[ -L "$WEB/dist" ]]; then
  old="$(readlink "$WEB/dist")"
  ln -sfn "$out" "$WEB/dist"                       # atomic: rename(2)
  say "dist -> $out"
  # Only ever delete our own build directories. A symlink someone pointed at
  # something else is left exactly where it is.
  if [[ -n "$old" && "$old" != "$out" && "$old" == dist.build-* ]]; then
    if [[ "$CARRY" == 1 && -d "$WEB/$old/assets" ]]; then
      # -n: never overwrite. The new build's own files always win; only names
      # the new build does not have are carried over.
      cp -Rn "$WEB/$old/assets/." "$WEB/$out/assets/" 2>/dev/null || true
      say "carried the previous build's assets forward (one generation)"
    fi
    rm -rf "$WEB/$old"
    say "dropped the previous build: $old"
  fi
elif [[ -d "$WEB/dist" ]]; then
  say "dist/ is a real directory — converting it to the symlink scheme"
  mv "$WEB/dist" "$WEB/dist.prev"
  ln -sfn "$out" "$WEB/dist"
  rm -rf "$WEB/dist.prev"
else
  ln -sfn "$out" "$WEB/dist"
  say "dist -> $out"
fi

# Prune, keeping the $KEEP newest. The build name embeds YYYYMMDD-HHMMSS, so
# glob order IS chronological order — no mtime parsing, and no `mapfile`, which
# macOS's stock bash 3.2 does not have.
names=()
for d in "$WEB"/dist.build-*; do
  [[ -d "$d" ]] && names+=("$(basename "$d")")
done
live="$(readlink "$WEB/dist" 2>/dev/null || true)"
len=${#names[@]}
if (( len > KEEP )); then
  for ((i = 0; i < len - KEEP; i++)); do
    # Never delete the build a running server may still be answering from.
    [[ "${names[$i]}" == "$live" ]] && continue
    rm -rf "$WEB/${names[$i]}"
    say "pruned $i: ${names[$i]}"
  done
fi

say "serving path: $WEB/dist  (a symlink — vite preview follows it per request)"
