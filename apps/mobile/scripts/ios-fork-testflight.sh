#!/usr/bin/env bash
# Archives a fork build of the iOS app and uploads it to TestFlight under your own Apple team.
# Run through `vp run ios:fork:testflight` from apps/mobile so `expo` is on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

export T3CODE_FORK_BUNDLE_ID=${T3CODE_FORK_BUNDLE_ID:-io.github.jasonlixfeld.t3fork}
export T3CODE_FORK_TEAM_ID=${T3CODE_FORK_TEAM_ID:-9V7672H2GA}
export T3CODE_FORK_APP_NAME=${T3CODE_FORK_APP_NAME:-T3 Fork}
export T3CODE_FORK_SCHEME=${T3CODE_FORK_SCHEME:-t3fork}
export T3CODE_IOS_BUILD_NUMBER=${T3CODE_IOS_BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}
export APP_VARIANT=production EXPO_NO_GIT_STATUS=1

: "${APPLE_ASC_KEY_ID:?Set APPLE_ASC_KEY_ID to your App Store Connect API key ID.}"
: "${APPLE_ASC_ISSUER_ID:?Set APPLE_ASC_ISSUER_ID to your App Store Connect issuer ID.}"
APPLE_ASC_KEY_PATH=${APPLE_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_ASC_KEY_ID}.p8}
if [ ! -f "$APPLE_ASC_KEY_PATH" ]; then
  echo "No App Store Connect API key at $APPLE_ASC_KEY_PATH. Set APPLE_ASC_KEY_PATH." >&2
  exit 1
fi

out="${TMPDIR:-/tmp}/lstack/t3-testflight-fork-app"
rm -rf "$out"
mkdir -p "$out"

expo prebuild --clean --platform ios

workspace=$(find ios -maxdepth 1 -name '*.xcworkspace' | head -n 1)
scheme=$(basename "$workspace" .xcworkspace)
archive="$out/$scheme.xcarchive"
auth=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$APPLE_ASC_KEY_PATH"
  -authenticationKeyID "$APPLE_ASC_KEY_ID"
  -authenticationKeyIssuerID "$APPLE_ASC_ISSUER_ID"
)

xcodebuild archive \
  -workspace "$workspace" \
  -scheme "$scheme" \
  -configuration Release \
  -destination generic/platform=iOS \
  -archivePath "$archive" \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$T3CODE_FORK_TEAM_ID" \
  "${auth[@]}"

cat >"$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$T3CODE_FORK_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
PLIST

# Homebrew's rsync breaks IPA packaging, so export with only the system tools on PATH.
PATH=/usr/bin:/bin:/usr/sbin:/sbin xcodebuild -exportArchive \
  -archivePath "$archive" \
  -exportPath "$out/export" \
  -exportOptionsPlist "$out/ExportOptions.plist" \
  "${auth[@]}"

ipa=$(find "$out/export" -maxdepth 1 -name '*.ipa' | head -n 1)
info=$(find "$archive/Products/Applications" -maxdepth 2 -name Info.plist | head -n 1)
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info")
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$info")

# altool finds the key by its AuthKey_<id>.p8 name in this directory.
API_PRIVATE_KEYS_DIR=$(dirname "$APPLE_ASC_KEY_PATH") xcrun altool --upload-app --type ios \
  --file "$ipa" --apiKey "$APPLE_ASC_KEY_ID" --apiIssuer "$APPLE_ASC_ISSUER_ID"

rm -rf "$out"
echo "Uploaded $T3CODE_FORK_BUNDLE_ID version $version build $build to App Store Connect."
