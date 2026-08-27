#!/usr/bin/env bash
# Keep release/ from turning into a museum of every build ever made.
#
# electron-builder writes release/<version>/{mac,mac-arm64}/AUTOcarl.app on
# every `npm run release`, and nothing ever removed them: 39 versions and
# 26 GB had piled up, and Spotlight indexed all 24 app bundles, so searching
# "AUTOcarl" returned a wall of copies. Runs before each release; keeps the
# newest KEEP versions and deletes the rest. Everything published lives on
# GitHub Releases, so anything pruned here is rebuildable and re-downloadable.
#
# Written for macOS's bash 3.2 — no mapfile, no associative arrays.
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP="${KEEP_RELEASES:-2}"

# Spotlight skips any directory holding this marker. Recreated every run in
# case a clean checkout or a wiped release/ loses it.
mkdir -p release
touch release/.metadata_never_index

versions=$(ls -1 release 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1nr -k2,2nr -k3,3nr || true)
# Note: the reverse flag must ride on each key (-k1,1nr). A trailing bare
# -r after numeric keys sorts ASCENDING here, which would have kept 0.9.0
# and deleted the current build.
total=$(printf '%s\n' "$versions" | grep -c . || true)
if [ "$total" -le "$KEEP" ]; then
  echo "prune-releases: $total build(s) present, keeping all (KEEP=$KEEP)"
  exit 0
fi

before=$(du -sk release | cut -f1)
printf '%s\n' "$versions" | tail -n +$((KEEP + 1)) | while read -r v; do
  [ -n "$v" ] || continue
  echo "prune-releases: removing release/$v"
  rm -rf "release/${v:?}"
done
after=$(du -sk release | cut -f1)
echo "prune-releases: kept $KEEP newest of $total, freed $(( (before - after) / 1024 )) MB"
