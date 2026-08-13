#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 5 ]]; then
  echo "usage: $0 APPLICATION.app IDENTITY CHANNEL VERSION ENTITLEMENTS.plist" >&2
  exit 2
fi

app="$1"
identity="$2"
channel="$3"
version="$4"
entitlements="$5"
plist="$app/Contents/Info.plist"

if [[ ! -d "$app/Contents" || -L "$app" || ! -f "$plist" || -L "$plist" ]]; then
  echo "invalid ZergMeeting application bundle" >&2
  exit 1
fi
if [[ ! -f "$entitlements" || -L "$entitlements" ]]; then
  echo "invalid macOS entitlement contract" >&2
  exit 1
fi
if [[ "$(wc -c <"$entitlements" | tr -d ' ')" -gt 16384 ]]; then
  echo "macOS entitlement contract exceeds its byte boundary" >&2
  exit 1
fi
plutil -lint "$entitlements" >/dev/null
if [[ "$channel" != "preview" && "$channel" != "stable" ]]; then
  echo "channel must be preview or stable" >&2
  exit 1
fi
if [[ "$channel" == "stable" && "$identity" == "-" ]]; then
  echo "stable signing requires a Developer ID identity" >&2
  exit 1
fi
if [[ "$channel" == "preview" && "$identity" != "-" ]]; then
  echo "preview signing must use the ad-hoc identity" >&2
  exit 1
fi
if find "$app" -type l -print -quit | grep -q .; then
  echo "application contains a symbolic link" >&2
  exit 1
fi
if find "$app" \! -type d \! -type f -print -quit | grep -q .; then
  echo "application contains a special filesystem entry" >&2
  exit 1
fi

identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")"
[[ "$identifier" == "com.zergai.meeting" ]] || {
  echo "unexpected bundle identifier: $identifier" >&2
  exit 1
}
[[ "$bundle_version" == "$version" ]] || {
  echo "unexpected bundle version: $bundle_version" >&2
  exit 1
}

sign_args=(--force --options runtime --sign "$identity")
if [[ "$channel" == "stable" ]]; then
  sign_args+=(--timestamp)
else
  sign_args+=(--timestamp=none)
fi

signed_macho_count=0
while IFS= read -r -d '' path; do
  if file -b "$path" | grep -q 'Mach-O'; then
    codesign "${sign_args[@]}" "$path"
    signed_macho_count=$((signed_macho_count + 1))
  fi
done < <(find "$app/Contents" -type f -print0)
if [[ "$signed_macho_count" -eq 0 ]]; then
  echo "application contains no Mach-O code" >&2
  exit 1
fi

while IFS= read -r -d '' nested; do
  codesign "${sign_args[@]}" "$nested"
done < <(
  find "$app/Contents" -depth -type d \
    \( -name '*.app' -o -name '*.framework' -o -name '*.xpc' \) -print0
)
outer_sign_args=("${sign_args[@]}" --entitlements "$entitlements")
codesign "${outer_sign_args[@]}" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

if [[ "$channel" == "stable" ]]; then
  signature_details="$(codesign -dv --verbose=4 "$app" 2>&1)"
  grep -F "Authority=Developer ID Application" <<<"$signature_details" >/dev/null
  grep -F "flags=" <<<"$signature_details" | grep -F "runtime" >/dev/null
else
  codesign -dv --verbose=4 "$app" 2>&1 | grep -F "Signature=adhoc" >/dev/null
fi

[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" == "com.zergai.meeting" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" == "$version" ]]
echo "Signed $signed_macho_count Mach-O files in $app"
