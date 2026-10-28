#!/bin/bash
# Builds ~/Desktop/Slate.app: double-click to open Slate in Opera (starting
# the server first if needed). Stock macOS tools only; no admin needed.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$HOME/Desktop/Slate.app}"
rm -rf "$OUT"
osacompile -o "$OUT" "$HERE/Slate.applescript"

# Icon: the brand mark, rendered into every size an .icns wants.
ICONSET="$(mktemp -d)/Slate.iconset"
mkdir -p "$ICONSET"
SRC="$ROOT/branding/slate-mark-dark-1024.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s*2))
  sips -z $d $d "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/applet.icns"
rm -rf "$(dirname "$ICONSET")"
# Finder caches icons by bundle; touching the bundle makes it look again.
touch "$OUT"
echo "built $OUT"
