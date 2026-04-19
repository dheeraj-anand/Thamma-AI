#!/usr/bin/env bash
# push-to-github.sh
# Pushes Thamma source code to GitHub and attaches the .dmg installer
# as a GitHub Release asset (the clean, standard approach — no LFS).
#
# RUN THIS FROM YOUR MAC TERMINAL:
#   cd ~/Desktop/Thamma
#   bash push-to-github.sh
#
# Target repo: https://github.com/dheeraj-anand/Thamma-AI
#
# Reruns are safe: steps already done become no-ops.

set -euo pipefail

REPO_URL="https://github.com/dheeraj-anand/Thamma-AI.git"
REPO_SLUG="dheeraj-anand/Thamma-AI"
BRANCH="main"
VERSION="v3.1.0"
DMG_PATH="dist/Thamma-3.1.0-arm64.dmg"

cd "$(dirname "$0")"
echo "Working directory: $(pwd)"
echo

# ---------------------------------------------------------------------------
# 1. Verify git is installed
# ---------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is not installed."
  echo "Install Xcode Command Line Tools:  xcode-select --install"
  exit 1
fi
echo "git: $(git --version)"

# ---------------------------------------------------------------------------
# 2. Initialize repo (if needed) and wire up the remote
# ---------------------------------------------------------------------------
if [ ! -d .git ]; then
  echo "Initializing new git repo on branch '$BRANCH'..."
  git init -b "$BRANCH"
else
  echo "Git repo already initialized."
  git checkout -B "$BRANCH" 2>/dev/null || true
fi

if git remote get-url origin >/dev/null 2>&1; then
  existing=$(git remote get-url origin)
  if [ "$existing" != "$REPO_URL" ]; then
    echo "Updating origin remote: $existing  ->  $REPO_URL"
    git remote set-url origin "$REPO_URL"
  else
    echo "Remote origin already set to $REPO_URL"
  fi
else
  echo "Adding remote origin -> $REPO_URL"
  git remote add origin "$REPO_URL"
fi

# ---------------------------------------------------------------------------
# 3. Stage and commit source code
#    (dist/, node_modules/, out/, *.dmg are all excluded by .gitignore)
# ---------------------------------------------------------------------------
echo
echo "Staging source files..."
git add .gitignore .gitattributes
git add -A

# Print what we're about to commit (first 25 entries)
echo
echo "Staged files (showing up to 25):"
git diff --cached --name-only | head -25
count=$(git diff --cached --name-only | wc -l | tr -d ' ')
echo "Total staged: $count file(s)"
echo

if git diff --cached --quiet; then
  echo "Nothing new to commit."
else
  git commit -m "Initial commit: Thamma source"
fi

# ---------------------------------------------------------------------------
# 4. Push source to GitHub
# ---------------------------------------------------------------------------
echo
echo "Pushing source to $REPO_URL ..."
git push -u origin "$BRANCH"
echo "Source push complete."

# ---------------------------------------------------------------------------
# 5. Create a release and upload the .dmg as an asset
# ---------------------------------------------------------------------------
echo
echo "=================================================================="
echo "  Now publishing release $VERSION with the .dmg installer"
echo "=================================================================="

if [ ! -f "$DMG_PATH" ]; then
  echo "WARNING: $DMG_PATH not found. Skipping release step."
  echo "If you want to publish a release later, rebuild the app (npm run build)"
  echo "then run:  gh release create $VERSION \"$DMG_PATH\" --repo $REPO_SLUG"
  exit 0
fi

dmg_size=$(du -h "$DMG_PATH" | cut -f1)
echo "Installer: $DMG_PATH ($dmg_size)"

if command -v gh >/dev/null 2>&1; then
  # Check auth
  if ! gh auth status >/dev/null 2>&1; then
    echo
    echo "You need to authenticate the gh CLI first. Run:"
    echo "  gh auth login"
    echo "Then rerun this script (it'll skip the already-done steps)."
    exit 1
  fi

  # Create release (or update if it already exists)
  if gh release view "$VERSION" --repo "$REPO_SLUG" >/dev/null 2>&1; then
    echo "Release $VERSION already exists. Uploading/overwriting the .dmg asset..."
    gh release upload "$VERSION" "$DMG_PATH" --repo "$REPO_SLUG" --clobber
  else
    echo "Creating release $VERSION and uploading the .dmg..."
    gh release create "$VERSION" "$DMG_PATH" \
      --repo "$REPO_SLUG" \
      --title "Thamma $VERSION" \
      --notes "macOS (Apple Silicon) installer for Thamma $VERSION.

Download: \`Thamma-3.1.0-arm64.dmg\`"
  fi

  echo
  echo "DONE."
  echo "Source:   $REPO_URL"
  echo "Release:  https://github.com/$REPO_SLUG/releases/tag/$VERSION"
else
  # ---- gh CLI not installed: fall back to manual web-UI instructions ----
  cat <<EOF

The GitHub CLI (\`gh\`) is not installed, so I can't upload the release asset automatically.

OPTION A — install gh and rerun this script:
    brew install gh
    gh auth login
    bash push-to-github.sh

OPTION B — do it manually in the browser (takes ~1 minute):
    1. Open https://github.com/$REPO_SLUG/releases/new
    2. Choose a tag:     $VERSION   (create new tag on branch $BRANCH)
    3. Release title:    Thamma $VERSION
    4. Drag and drop:    $(pwd)/$DMG_PATH
       (GitHub Releases allow files up to 2 GB — the $dmg_size .dmg is fine.)
    5. Click "Publish release".

Either way, after publishing, anyone can download the installer from:
    https://github.com/$REPO_SLUG/releases

EOF
fi
