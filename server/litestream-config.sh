#!/bin/sh
set -e

# Prints a Litestream config that copies the database at $1 to LITESTREAM_REPLICA_URL
# through the S3-compatible store at LITESTREAM_ENDPOINT (Cloudflare R2, Backblaze B2,
# MinIO...). Litestream 0.3 takes an S3 endpoint only from a config file: in a replica
# URL it ignores `?endpoint=` and talks to AWS.
#
# The URL and endpoint stay `${VAR}` references, which Litestream expands when it reads
# the file. The keys are not in the file at all: Litestream reads
# LITESTREAM_ACCESS_KEY_ID and LITESTREAM_SECRET_ACCESS_KEY from the environment.
#
# A sync every 10 s keeps an idle-to-busy chat server well inside R2's free monthly
# writes; a snapshot a day with 3 days of history allows going back to before a mistake.

cat <<EOF
dbs:
  - path: "$1"
    replicas:
      - url: "\${LITESTREAM_REPLICA_URL}"
        endpoint: "\${LITESTREAM_ENDPOINT}"
        region: "${LITESTREAM_REGION:-auto}"
        sync-interval: 10s
        snapshot-interval: 24h
        retention: 72h
EOF
