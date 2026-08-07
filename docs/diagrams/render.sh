#!/usr/bin/env bash
# Regenerate the §1.6 data-flow diagrams as 2x PNGs.
#
#   ./render.sh            -> dfd_a.svg/.png, dfd_b.svg/.png
#
# Headless Chrome is the renderer because it is already on every dev machine
# here and rasterises SVG text with the same font stack the SVG asks for.
# rsvg-convert or Inkscape would work equally well if you prefer.
set -euo pipefail
cd "$(dirname "$0")"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "Chrome not found at: $CHROME" >&2; exit 1; }

python3 gen.py

for v in a b; do
  # Match the window to the SVG canvas so there is no letterboxing. The file is
  # a single line, so anchor on the root viewBox rather than any width= pair:
  # every label plate carries one of those too.
  dims=$(grep -o 'viewBox="0 0 [0-9]* [0-9]*"' "dfd_$v.svg" | head -1)
  w=$(echo "$dims" | awk '{print $3+0}')
  h=$(echo "$dims" | awk '{print $4+0}')
  [ "$w" -gt 0 ] && [ "$h" -gt 0 ] || { echo "bad canvas in dfd_$v.svg" >&2; exit 1; }
  "$CHROME" --headless --disable-gpu --no-sandbox \
    --screenshot="dfd_$v.png" --window-size="$w,$h" \
    --default-background-color=FFFFFF --force-device-scale-factor=2 \
    "file://$PWD/dfd_$v.svg" 2>/dev/null
  echo "dfd_$v.png  ($((w * 2))x$((h * 2)))"
done
