#!/bin/sh
#
# Container entrypoint.
#
# Two jobs, then hands off:
#
#   1. Make sure /data is writable by the process user.
#      The bind mount is created by whoever ran mkdir on the host - typically a
#      normal user, not uid 1000 - so the gateway would fail on first write with
#      "EACCES: mkdir '/data/.chat2api'". Fixing it here means deployment is just
#      "compose up", with no manual chown step.
#
#   2. Drop privileges and exec the real command, so the long-running process
#      does not run as root.
#
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/.chat2api
  chown node:node /data 2>/dev/null || true
  # Only the app's own directory is walked; the volume may also hold
  # operator-managed files we should not touch.
  chown -R node:node /data/.chat2api 2>/dev/null || true

  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec node "$@"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@" 2>/dev/null \
    || exec su node -c "exec \"$*\""
fi

exec "$@"
