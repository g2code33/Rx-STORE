#!/bin/sh
# Finish the system-wide .deb installation.
set -e

APP_DIR='/opt/RX Store'

# Electron/Chromium refuses to launch when its SUID sandbox is present but does
# not have the privileged ownership/mode it requires. electron-builder's .deb
# payload preserves it as an ordinary file, so correct it while dpkg is already
# running this hook as root.
if [ -f "$APP_DIR/chrome-sandbox" ]; then
  chown root:root "$APP_DIR/chrome-sandbox"
  chmod 4755 "$APP_DIR/chrome-sandbox"
fi

# Make the GUI binary available from a terminal as `rx-store`.
ln -sf "$APP_DIR/rx-store" '/usr/bin/rx-store'
