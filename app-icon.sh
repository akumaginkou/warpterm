#!/usr/bin/env bash
# Regenerate the warpterm app icon source (app-icon.png), then the platform icon
# set. Pure ImageMagick primitives — no SVG rasteriser needed.
#
#   ./app-icon.sh            # -> app-icon.png + src-tauri/icons/*
#
# Motif: a terminal prompt ">" + block cursor in Cloudflare orange (#f6821f) on a
# dark rounded square, with an orange base accent nodding to WARP.
set -euo pipefail
cd "$(dirname "$0")"

FONT=${FONT:-/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf}
OUT=app-icon.png
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Dark diagonal gradient, clipped to a rounded square.
convert -size 1024x1024 gradient:'#20242e'-'#0d0f14' "$TMP/grad.png"
convert -size 1024x1024 xc:none -fill white \
  -draw "roundrectangle 32,32 992,992 190,190" "$TMP/mask.png"
convert "$TMP/grad.png" "$TMP/mask.png" -alpha off -compose CopyOpacity -composite "$TMP/base.png"

# Orange base accent bar (nod to WARP), re-clipped to the rounded corners.
convert "$TMP/base.png" \
  \( -size 1024x1024 xc:none -fill '#f6821f' -draw "roundrectangle 32,900 992,992 40,40" \) \
  -compose over -composite \
  "$TMP/mask.png" -alpha off -compose CopyOpacity -composite "$TMP/base2.png"

# Prompt ">" + block cursor.
convert "$TMP/base2.png" \
  -font "$FONT" -fill '#f6821f' -pointsize 540 -gravity center -annotate +-118-40 '>' \
  -fill '#f6821f' -draw "roundrectangle 560,330 720,690 20,20" \
  "$OUT"

echo "wrote $OUT"

# Generate the platform icon set into src-tauri/icons/ (needs the Tauri CLI).
if command -v cargo-tauri >/dev/null 2>&1; then
  cargo tauri icon "$OUT"
else
  npx --yes @tauri-apps/cli@^2 icon "$OUT"
fi
