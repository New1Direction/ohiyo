#!/bin/sh
# Foreground supervisor service; requires the verified ImOrb Chromium profile.
set -eu
umask 077
mkdir -p /orb/state/burrow/profile
chmod 700 /orb/state/burrow /orb/state/burrow/profile
exec /usr/bin/chromium --headless --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check --disable-background-networking \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir=/orb/state/burrow/profile \
  --proxy-server=http://127.0.0.1:8766 --proxy-bypass-list='<-loopback>' \
  about:blank
