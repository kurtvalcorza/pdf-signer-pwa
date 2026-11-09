#!/usr/bin/env bash
# Release emulator gate (feature 003, T042). Run inside the emulator step of release-desktop.yml,
# or locally against a running emulator:
#
#   bash scripts/android-release-gate.sh <signed-release.apk>
#
# 1. The emulator's WebView major must equal android/VALIDATED_WEBVIEW. That file is the floor the
#    app reports as validated (R11), so the gate must have run on exactly that engine. A newer
#    system image fails here on purpose: re-validate, then update the file in its own commit.
# 2. scripts/android-gate.mjs with the release flag set (C8, C10-C12, US1-US3, large files).
set -euo pipefail

apk="${1:?usage: android-release-gate.sh <signed-release.apk>}"
adb_bin="${ADB:-adb}"

want=$(tr -d '[:space:]' < android/VALIDATED_WEBVIEW)
# No pipe: an updated WebView lists versionName twice, and under pipefail a reader that stops
# early (head, sed q) can fail the step with SIGPIPE.
dump=$("$adb_bin" shell dumpsys package com.google.android.webview)
have=$(sed -n 's/.*versionName=\([0-9][0-9]*\)\..*/\1/p' <<<"$dump")
have=${have%%$'\n'*}
echo "WebView major on the gate emulator: ${have:-none}; android/VALIDATED_WEBVIEW: $want"
if [ "$have" != "$want" ]; then
  echo "::error::the gate emulator runs WebView ${have:-none}, but android/VALIDATED_WEBVIEW says $want"
  exit 1
fi

node scripts/android-gate.mjs "$apk" --adb "$adb_bin" --network-on --backup --large
