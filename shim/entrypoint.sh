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
#      "compose up", with no manual chown.
#
#   2. Drop privileges and exec the real command, so the long-running process
#      does not run as root.
#
set -e

if [ "$(id -u)" != "0" ]; then
  # Already unprivileged (e.g. compose run with user:), nothing to do.
  exec "$@"
fi

if ! command -v su-exec >/dev/null 2>&1; then
  echo 'ERROR: su-exec is missing from the image; cannot drop privileges' >&2
  exit 1
fi

mkdir -p /data/.chat2api
# The volume itself may hold operator-managed files; only the app's own
# directory is walked.
chown node:node /data 2>/dev/null || true
chown -R node:node /data/.chat2api 2>/dev/null || true

exec su-exec node "$@"
