#!/usr/bin/env bash
# Builds a universal, ad-hoc-signed ThinkSL8.app (plus .dmg and .zip) into mac/build/. Needs macOS + Xcode command line tools.
set -euo pipefail
cd "$(dirname "$0")"
OUT="$PWD/build"; APP="$OUT/ThinkSL8.app"; TMP="$OUT/tmp"
rm -rf "${OUT:?}"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$TMP"

for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" -lsqlite3 -o "$TMP/ThinkSL8-$arch" main.swift Http.swift Store.swift Sync.swift Local.swift
done
lipo -create -output "$APP/Contents/MacOS/ThinkSL8" "$TMP"/ThinkSL8-arm64 "$TMP"/ThinkSL8-x86_64
cp Info.plist "$APP/Contents/Info.plist"

# The website itself, bundled: the app shows these pages from a local server and keeps working offline
cp -R ../public "$APP/Contents/Resources/web"

# Icon from the web app's 512px PNG
I="$TMP/AppIcon.iconset"; mkdir -p "$I"
SRC=../public/icon-512.png
for s in 16 32 128 256 512; do sips -z $s $s "$SRC" --out "$I/icon_${s}x${s}.png" >/dev/null; done
for s in 16 32 128 256; do sips -z $((s*2)) $((s*2)) "$SRC" --out "$I/icon_${s}x${s}@2x.png" >/dev/null; done
iconutil -c icns "$I" -o "$APP/Contents/Resources/AppIcon.icns"

codesign --force --deep -s - "$APP"

D="$OUT/dmg"; mkdir -p "$D"; cp -R "$APP" "$D/"; ln -s /Applications "$D/Applications"
hdiutil create -volname ThinkSL8 -srcfolder "$D" -ov -format UDZO "$OUT/ThinkSL8.dmg" >/dev/null
ditto -c -k --keepParent "$APP" "$OUT/ThinkSL8.zip"
rm -rf "${D:?}" "${TMP:?}"
echo "Built $APP, $OUT/ThinkSL8.dmg, $OUT/ThinkSL8.zip"
