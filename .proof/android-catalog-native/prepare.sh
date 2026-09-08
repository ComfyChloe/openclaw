#!/usr/bin/env bash
set -euo pipefail
test -n "$TRIAL"
test -n "$SDK_ROOT"
mkdir "$TRIAL/apk" "$TRIAL/runtime"
gh api --hostname github.com repos/openclaw/openclaw/actions/artifacts/10070823992/zip > "$TRIAL/apk.zip"
unset GH_TOKEN
printf '%s  %s\n' 64140821d2baa31fd0c9ff33ff85be6fb9f4a66e44657e2ff57cf0f2286e5fda "$TRIAL/apk.zip" | sha256sum -c -
test "$(stat -c %s "$TRIAL/apk.zip")" = 135819386
unzip -Z1 "$TRIAL/apk.zip" | LC_ALL=C sort > "$TRIAL/archive-files.txt"
printf '%s\n' BuildConfig.java SHA256SUMS build.json candidate.apk output-metadata.json package.txt signing.txt > "$TRIAL/expected-files.txt"
diff -u "$TRIAL/expected-files.txt" "$TRIAL/archive-files.txt"
while IFS= read -r file; do unzip -p "$TRIAL/apk.zip" "$file" > "$TRIAL/apk/$file"; done < "$TRIAL/expected-files.txt"
(cd "$TRIAL/apk" && sha256sum -c SHA256SUMS)
printf '%s  %s\n' 0330ce2a24ccffd84353d71c57e96768b425e5e90fd8de0e49f9f05672119d45 "$TRIAL/apk/candidate.apk" | sha256sum -c -
jq -e '.sourceCommit == "575c21f72a45fe6b62c3bf4d8871bfefb772479e" and .workflowCommit == "46d22c43a8ff32e4d40cc398523fc413eda9b046" and .runId == "34262621356" and .runAttempt == "1"' "$TRIAL/apk/build.json"
grep -F 'd707a62f9e84c0533f1f384a50e97a9b3abfab4a760a24c28287d4b1d127454b' "$TRIAL/apk/signing.txt"
test -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
test -x "$SDK_ROOT/cmdline-tools/latest/bin/avdmanager"
manager="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
yes | "$manager" --sdk_root="$SDK_ROOT" --licenses >/dev/null || test "${PIPESTATUS[1]}" = 0
"$manager" --sdk_root="$SDK_ROOT" --install emulator 'system-images;android-36;google_apis;x86_64' platform-tools
# Same Bun version and package-manager route as the pinned setup-node-env owner.
npm install --prefix "$TRIAL/runtime" --no-audit --no-fund bun@1.4.0
test "$("$TRIAL/runtime/node_modules/.bin/bun" --version)" = 1.4.0
for path in emulator/package.xml platform-tools/package.xml system-images/android-36/google_apis/x86_64/package.xml; do
  printf '\nMetadata source: %s\n' "$path"
  cat "$SDK_ROOT/$path"
done
"$SDK_ROOT/platform-tools/adb" version
"$SDK_ROOT/emulator/emulator" -no-window -no-audio -version
