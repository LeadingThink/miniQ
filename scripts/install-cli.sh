#!/usr/bin/env sh
# Download the official prebuilt pair without restarting a daemon.
set -eu
fail() { printf 'miniQ: %s\n' "$*" >&2; exit 1; }
fetch() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --connect-timeout 15 --max-time 600 --retry 2 "$1" -o "$2"
}
replace() {
  if [ "$MINIQ_OS" = Darwin ]; then mv -fh "$1" "$2"; else mv -fT "$1" "$2"; fi
}
field() { sed -n 's/^[[:space:]]*"'"$1"'": "\([^"\\]*\)"[,]*[[:space:]]*$/\1/p' "$2"; }
command -v curl >/dev/null 2>&1 || fail 'Install curl, then retry.'
command -v tar >/dev/null 2>&1 || fail 'Install tar, then retry.'
MINIQ_OS=$(uname -s)
MINIQ_ARCH=$(uname -m)
case "$MINIQ_OS/$MINIQ_ARCH" in
  Darwin/arm64|Darwin/aarch64) MINIQ_TARGET=aarch64-apple-darwin ;;
  Darwin/x86_64) MINIQ_TARGET=x86_64-apple-darwin ;;
  Linux/x86_64|Linux/amd64)
    MINIQ_TARGET=x86_64-unknown-linux-gnu
    MINIQ_LIBC=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
    printf '%s\n' "$MINIQ_LIBC" | awk '$1 == "glibc" { split($2,v,"."); if (v[1]>2 || (v[1]==2 && v[2]>=31)) ok=1 } END { exit !ok }' ||
      fail 'Linux requires x86-64 and glibc 2.31 or later. Alpine/musl and Linux ARM are not supported.' ;;
  *) fail "Unsupported platform: $MINIQ_OS/$MINIQ_ARCH. Windows: use install.ps1." ;;
esac
MINIQ_INSTALL_DIR=${MINIQ_INSTALL_DIR:-"$HOME/.local/bin"}
case "$MINIQ_INSTALL_DIR" in /*) ;; *) fail 'MINIQ_INSTALL_DIR must be an absolute path.' ;; esac
case "$MINIQ_INSTALL_DIR" in *'
'*) fail 'Installation path must not contain a newline.' ;; esac
MINIQ_PIN=${MINIQ_VERSION:-}
if [ -n "$MINIQ_PIN" ]; then
  printf '%s\n' "$MINIQ_PIN" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'MINIQ_VERSION must be x.y.z.'
fi
MINIQ_WORK=$(mktemp -d "${TMPDIR:-/tmp}/miniq-install.XXXXXX")
MINIQ_LOCKED=0
MINIQ_MIGRATING=0
MINIQ_COMMITTED=0
cleanup() {
  if [ "$MINIQ_MIGRATING" = 1 ] && [ "$MINIQ_COMMITTED" = 0 ]; then
    for MINIQ_PROGRAM in miniq miniq-daemon; do
      if [ -e "$MINIQ_LOCK/restore-$MINIQ_PROGRAM" ] || [ -L "$MINIQ_LOCK/restore-$MINIQ_PROGRAM" ]; then
        replace "$MINIQ_LOCK/restore-$MINIQ_PROGRAM" "$MINIQ_INSTALL_DIR/$MINIQ_PROGRAM"
      elif [ -f "$MINIQ_LOCK/absent-$MINIQ_PROGRAM" ]; then
        rm -f "$MINIQ_INSTALL_DIR/$MINIQ_PROGRAM"
      fi
    done
  fi
  rm -rf "$MINIQ_WORK"
  if [ "$MINIQ_LOCKED" = 1 ]; then rm -rf "$MINIQ_LOCK"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
MINIQ_ORIGIN=https://oss.zaiwen.top/releases/miniq
MINIQ_METADATA="$MINIQ_ORIGIN/terminal.json"
if [ -n "$MINIQ_PIN" ]; then MINIQ_METADATA="$MINIQ_ORIGIN/v$MINIQ_PIN/terminal.json"; fi
printf 'Downloading miniQ terminal metadata…\n'
fetch "$MINIQ_METADATA" "$MINIQ_WORK/terminal.json"
# Parse only the builder's fixed schema; reject duplicate or unexpected fields.
# This keeps the native installer independent of Python, Node and jq.
MINIQ_VERSION=$(field version "$MINIQ_WORK/terminal.json")
printf '%s\n' "$MINIQ_VERSION" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Invalid terminal manifest version.'
[ -z "$MINIQ_PIN" ] || [ "$MINIQ_VERSION" = "$MINIQ_PIN" ] || fail 'Manifest version does not match requested version.'
awk -v target="$MINIQ_TARGET" '$0 ~ "\"" target "\": \\{" { active=1; next } active && /}/ {active=0} active {print}' \
  "$MINIQ_WORK/terminal.json" > "$MINIQ_WORK/platform.json"
MINIQ_URL=$(field url "$MINIQ_WORK/platform.json")
MINIQ_SHA=$(field sha256 "$MINIQ_WORK/platform.json")
printf '%s\n' "$MINIQ_SHA" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$' || fail "No valid release checksum for $MINIQ_TARGET."
[ "$MINIQ_URL" = "$MINIQ_ORIGIN/v$MINIQ_VERSION/miniQ_terminal_${MINIQ_VERSION}_${MINIQ_TARGET}.tar.gz" ] || fail 'Invalid terminal archive URL.'
fetch "$MINIQ_URL" "$MINIQ_WORK/archive.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  MINIQ_ACTUAL=$(sha256sum "$MINIQ_WORK/archive.tar.gz" | awk '{print $1}')
else
  MINIQ_ACTUAL=$(shasum -a 256 "$MINIQ_WORK/archive.tar.gz" | awk '{print $1}')
fi
[ "$MINIQ_ACTUAL" = "$MINIQ_SHA" ] || fail 'Archive checksum mismatch; existing installation was not changed.'
tar -tzf "$MINIQ_WORK/archive.tar.gz" > "$MINIQ_WORK/entries"
while IFS= read -r MINIQ_ENTRY; do
  case "$MINIQ_ENTRY" in ./|./miniq|./miniq-daemon|./README.md|miniq|miniq-daemon|README.md) ;;
    *) fail "Unexpected archive entry: $MINIQ_ENTRY" ;; esac
done < "$MINIQ_WORK/entries"
mkdir "$MINIQ_WORK/payload"
tar -xzf "$MINIQ_WORK/archive.tar.gz" -C "$MINIQ_WORK/payload"
for MINIQ_PROGRAM in miniq miniq-daemon; do
  [ -f "$MINIQ_WORK/payload/$MINIQ_PROGRAM" ] && [ ! -L "$MINIQ_WORK/payload/$MINIQ_PROGRAM" ] || fail "Missing executable: $MINIQ_PROGRAM"
  chmod 755 "$MINIQ_WORK/payload/$MINIQ_PROGRAM"
done
[ "$("$MINIQ_WORK/payload/miniq" --version)" = "miniq $MINIQ_VERSION" ] || fail 'Downloaded executable version does not match the manifest.'
mkdir -p "$MINIQ_INSTALL_DIR"
MINIQ_INSTALL_DIR=$(CDPATH= cd -- "$MINIQ_INSTALL_DIR" && pwd -P)
MINIQ_LOCK="$MINIQ_INSTALL_DIR/.miniq-install.lock"
mkdir "$MINIQ_LOCK" 2>/dev/null || fail "Another installer holds $MINIQ_LOCK. Retry when it finishes."
MINIQ_LOCKED=1
printf '%s\n' "$$" > "$MINIQ_LOCK/pid"
MINIQ_STORE="$MINIQ_INSTALL_DIR/.miniq"
mkdir -p "$MINIQ_STORE/versions"
if [ -e "$MINIQ_STORE/managed" ]; then
  [ "$(cat "$MINIQ_STORE/managed")" = miniq-terminal-v1 ] || fail 'Unknown installer layout; existing installation was not changed.'
fi
MINIQ_RELEASE="$MINIQ_STORE/versions/$MINIQ_VERSION"
if [ -e "$MINIQ_RELEASE" ]; then
  for MINIQ_PROGRAM in miniq miniq-daemon; do
    cmp -s "$MINIQ_RELEASE/$MINIQ_PROGRAM" "$MINIQ_WORK/payload/$MINIQ_PROGRAM" || fail "Existing version $MINIQ_VERSION differs; refusing to overwrite it."
  done
else
  MINIQ_STAGE=$(mktemp -d "$MINIQ_STORE/versions/.stage.XXXXXX")
  cp "$MINIQ_WORK/payload/miniq" "$MINIQ_WORK/payload/miniq-daemon" "$MINIQ_STAGE/"
  chmod 755 "$MINIQ_STAGE/miniq" "$MINIQ_STAGE/miniq-daemon"
  mv "$MINIQ_STAGE" "$MINIQ_RELEASE"
fi
# The links remain stable across updates; one pointer activates the whole pair.
# In-flight processes retain the old immutable version and its sibling daemon.
for MINIQ_PROGRAM in miniq miniq-daemon; do
  [ ! -d "$MINIQ_INSTALL_DIR/$MINIQ_PROGRAM" ] || fail "Cannot replace a directory: $MINIQ_PROGRAM"
  if [ -e "$MINIQ_INSTALL_DIR/$MINIQ_PROGRAM" ] || [ -L "$MINIQ_INSTALL_DIR/$MINIQ_PROGRAM" ]; then
    cp -P "$MINIQ_INSTALL_DIR/$MINIQ_PROGRAM" "$MINIQ_LOCK/restore-$MINIQ_PROGRAM"
  else
    touch "$MINIQ_LOCK/absent-$MINIQ_PROGRAM"
  fi
done
MINIQ_MIGRATING=1
for MINIQ_PROGRAM in miniq miniq-daemon; do
  MINIQ_LINK=".miniq/current/$MINIQ_PROGRAM"
  if [ "$(readlink "$MINIQ_INSTALL_DIR/$MINIQ_PROGRAM" 2>/dev/null || true)" != "$MINIQ_LINK" ]; then
    ln -s "$MINIQ_LINK" "$MINIQ_LOCK/$MINIQ_PROGRAM"
    replace "$MINIQ_LOCK/$MINIQ_PROGRAM" "$MINIQ_INSTALL_DIR/$MINIQ_PROGRAM"
  fi
done
ln -s "versions/$MINIQ_VERSION" "$MINIQ_LOCK/current"
printf 'miniq-terminal-v1\n' > "$MINIQ_STORE/managed"
replace "$MINIQ_LOCK/current" "$MINIQ_STORE/current"
MINIQ_COMMITTED=1
if [ "${MINIQ_NO_MODIFY_PATH:-0}" != 1 ]; then
  MINIQ_ESCAPED=$(printf '%s' "$MINIQ_INSTALL_DIR" | sed "s/'/'\\\\''/g")
  MINIQ_SHELL=${SHELL:-}
  if [ -z "$MINIQ_SHELL" ]; then
    if [ "$MINIQ_OS" = Darwin ]; then MINIQ_SHELL=/bin/zsh; else MINIQ_SHELL=/bin/sh; fi
  fi
  case "$MINIQ_SHELL" in
    */zsh) MINIQ_PROFILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash) if [ "$MINIQ_OS" = Darwin ]; then MINIQ_PROFILE="$HOME/.bash_profile"; else MINIQ_PROFILE="$HOME/.bashrc"; fi ;;
    */fish) MINIQ_PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/miniq.fish" ;;
    *) MINIQ_PROFILE="$HOME/.profile" ;;
  esac
  mkdir -p "$(dirname "$MINIQ_PROFILE")"
  if [ "${MINIQ_SHELL##*/}" = fish ]; then
    MINIQ_FISH_PATH=$(printf '%s' "$MINIQ_INSTALL_DIR" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")
    MINIQ_PATH_LINE="fish_add_path -- '$MINIQ_FISH_PATH'"
  else
    MINIQ_PATH_LINE="export PATH='$MINIQ_ESCAPED':\"\$PATH\""
  fi
  if ! LC_ALL=C grep -Fx "$MINIQ_PATH_LINE" "$MINIQ_PROFILE" >/dev/null 2>&1; then
    printf '\n# miniQ terminal PATH\n%s\n' "$MINIQ_PATH_LINE" >> "$MINIQ_PROFILE"
  fi
fi
printf '\nminiQ %s installed in %s\n' "$MINIQ_VERSION" "$MINIQ_INSTALL_DIR"
printf 'Open a new terminal and run: miniq\nUpdate later with: miniq update\n'
printf 'Existing tasks keep running. The new daemon is used after the current daemon exits safely.\n'
