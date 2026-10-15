#!/usr/bin/env bash
# Installs Android cmdline-tools and $ANDROID_SDK_PACKAGES into $ANDROID_HOME (ADR 0002).
# The directory is cached by the workflow, so after the first run this is only an "already installed" check.
set -euo pipefail

sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$sdkmanager" ]; then
    command -v unzip > /dev/null || { apt-get update -qq && apt-get install -y -qq unzip > /dev/null; }
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    curl -sSfL --retry 5 --retry-all-errors -o /tmp/clt.zip "https://dl.google.com/android/repository/$ANDROID_CMDLINE_TOOLS"
    unzip -q /tmp/clt.zip -d "$ANDROID_HOME/cmdline-tools"
    mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
fi
yes | "$sdkmanager" --licenses > /dev/null || true
# Ağ hatasında birkaç kez dene (indirmeler arada yarıda kesilebiliyor)
for try in 1 2 3; do
    # shellcheck disable=SC2086 # word splitting into package names is intended
    "$sdkmanager" $ANDROID_SDK_PACKAGES > /dev/null && exit 0
    echo "sdkmanager başarısız (deneme $try), yeniden deneniyor..." >&2
    sleep 10
done
exit 1
