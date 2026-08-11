#!/bin/sh
# A mounted cloud disk (Render, Fly, Railway) arrives empty and root-owned. The
# app runs as `node`, so without this it cannot create the database and SQLite
# fails with EACCES on the first write — after a successful build and a green
# health check, which makes it a confusing failure to debug.
#
# Docker named volumes do not show the problem, because they inherit ownership
# from the image. Only a real provisioned disk does.
#
# Start as root, fix the mount, then drop privileges for the actual process.
set -e

DATA_DIR="$(dirname "${GR_DB:-/data/grading-room.db}")"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" || true
  exec su-exec node "$@"
fi

# Already unprivileged (some platforms pin the UID) — just run.
exec "$@"
