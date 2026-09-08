#!/usr/bin/env sh
# Builds both binaries before installing either. Does not start/stop the daemon.
set -eu

MINIQ_SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MINIQ_INSTALL_DIR=${MINIQ_INSTALL_DIR:-"${HOME}/.local/bin"}

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo "Use scripts/install-cli.ps1 on Windows, or run this script inside WSL." >&2; exit 1 ;;
esac
if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust is required for source installation: https://rustup.rs/" >&2
  exit 1
fi

cd "$MINIQ_SOURCE_DIR"
cargo build --release --locked -p miniq-cli -p miniq-daemon --bin miniq --bin miniq-daemon
MINIQ_BUILD_DIR=${CARGO_TARGET_DIR:-"$MINIQ_SOURCE_DIR/target"}
mkdir -p "$MINIQ_INSTALL_DIR"
for MINIQ_PROGRAM in miniq miniq-daemon; do
  MINIQ_STAGE=$(mktemp "$MINIQ_INSTALL_DIR/.${MINIQ_PROGRAM}.XXXXXX")
  install -m 755 "$MINIQ_BUILD_DIR/release/$MINIQ_PROGRAM" "$MINIQ_STAGE"
  mv -f "$MINIQ_STAGE" "$MINIQ_INSTALL_DIR/$MINIQ_PROGRAM"
done
"$MINIQ_INSTALL_DIR/miniq" --version
echo "Installed into $MINIQ_INSTALL_DIR. Add this directory to PATH if needed."
echo "The running miniQ daemon was NOT restarted. New capabilities activate after a safe restart."
echo "Next: miniq configure --base-url https://your-endpoint/v1 --model MODEL"
echo "PDF vision: install Poppler (macOS: brew install poppler; Ubuntu/Debian: apt install poppler-utils)."
