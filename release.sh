#!/usr/bin/env bash
# release.sh — Obsidian plugin release automation
# Usage: ./release.sh [version]
# Example: ./release.sh 1.1.0
# If no version is provided, the script will prompt for one.

set -euo pipefail

# helpers
red()   { echo -e "\033[31m$*\033[0m"; }
green() { echo -e "\033[32m$*\033[0m"; }
info()  { echo -e "\033[34m[info]\033[0m $*"; }
die()   { red "Error: $*"; exit 1; }

# version argument
if [ -n "${1:-}" ]; then
  NEW_VERSION="$1"
else
  CURRENT_VERSION=$(node -p "require('./package.json').version")
  echo "Current version: $CURRENT_VERSION"
  read -rp "New version: " NEW_VERSION
fi

# basic semver check
[[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "Version must be semver format like 1.2.3, got: $NEW_VERSION"

# pre-flight checks
info "Checking prerequisites..."
command -v gh >/dev/null 2>&1 || die "'gh' CLI not found. Install with: brew install gh"
command -v jq >/dev/null 2>&1 || die "'jq' not found. Install with: brew install jq"

# ensure on main/master and working tree is clean
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" == "main" || "$BRANCH" == "master" ]] \
  || die "Must be on main/master branch (currently on '$BRANCH')"

[[ -z "$(git status --porcelain)" ]] \
  || die "Working tree is not clean. Commit or stash changes first."

# read plugin metadata
PLUGIN_ID=$(jq -r '.id' manifest.json)
PLUGIN_NAME=$(jq -r '.name' manifest.json)

[[ -n "$PLUGIN_ID" && "$PLUGIN_ID" != "null" ]] \
  || die "manifest.json id is missing"
[[ -n "$PLUGIN_NAME" && "$PLUGIN_NAME" != "null" ]] \
  || die "manifest.json name is missing"

# bump versions
info "Bumping version to $NEW_VERSION..."

# package.json
jq --arg v "$NEW_VERSION" '.version = $v' package.json > package.json.tmp \
  && mv package.json.tmp package.json

# manifest.json
jq --arg v "$NEW_VERSION" '.version = $v' manifest.json > manifest.json.tmp \
  && mv manifest.json.tmp manifest.json

# versions.json: read minAppVersion from manifest then append entry
MIN_APP_VERSION=$(jq -r '.minAppVersion' manifest.json)
jq --arg v "$NEW_VERSION" --arg min "$MIN_APP_VERSION" \
  '. + {($v): $min}' versions.json > versions.json.tmp \
  && mv versions.json.tmp versions.json

# build
info "Building..."
npm run build

# commit & tag
info "Creating commit and tag $NEW_VERSION..."
git add package.json manifest.json versions.json main.js styles.css
git commit -m "chore: release $NEW_VERSION"
git tag "$NEW_VERSION"

# push
info "Pushing to remote..."
git push origin "$BRANCH"
git push origin "$NEW_VERSION"

# create zip for manual / mobile install
ZIP_NAME="${PLUGIN_ID}-${NEW_VERSION}.zip"
info "Creating $ZIP_NAME for manual installation..."
TMP_DIR=$(mktemp -d)
mkdir -p "$TMP_DIR/$PLUGIN_ID"
cp main.js manifest.json styles.css "$TMP_DIR/$PLUGIN_ID/"
(cd "$TMP_DIR" && zip -r - "$PLUGIN_ID") > "$ZIP_NAME"
rm -rf "$TMP_DIR"

# create GitHub release
info "Creating GitHub Release..."
gh release create "$NEW_VERSION" \
  main.js \
  manifest.json \
  styles.css \
  "$ZIP_NAME" \
  --title "$NEW_VERSION" \
  --notes "Release $NEW_VERSION

## Manual installation (Android / iOS / Desktop)
1. Download ${ZIP_NAME}
2. Extract it - you will get a ${PLUGIN_ID}/ folder
3. Move that folder into your vault's .obsidian/plugins/ directory
4. In Obsidian > Settings > Community plugins, enable ${PLUGIN_NAME}" \
  --latest
rm -f "$ZIP_NAME"

green "✓ Released $NEW_VERSION successfully!"
echo ""
echo "Next steps to publish to the Obsidian community plugin list:"
echo "  1. Fork https://github.com/obsidianmd/obsidian-releases"
echo "  2. Add your plugin to community-plugins.json:"
echo "     { \"id\": \"$PLUGIN_ID\", \"name\": \"$PLUGIN_NAME\", \"author\": \"MichaelLing83\"," 
echo "       \"description\": \"Turn vault directories into flashcard decks with spaced-repetition (SM-2).\", \"repo\": \"MichaelLing83/Obsidian-flashcards\" }"
echo "  3. Submit a Pull Request to obsidianmd/obsidian-releases"
