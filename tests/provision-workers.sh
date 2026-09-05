#!/usr/bin/env bash
#
# Provision parallel-suite fixtures (test-all.sh): worker 1 uses the
# historical test/test-manuscripts pair; workers 2..K get testN users and
# test-manuscripts-wN repo copies + grants. Idempotent — reruns are no-ops.
# The wN manuscript entries must exist in config.dev.yaml (w2..w8 do) —
# the server registers manuscript rows from that registry at startup, so a
# new worker count needs a config block AND a server restart first.
set -u

K="${1:-8}"
REPOS="$HOME/.config/manuscript-studio-dev/repos"
API="http://localhost:${MS_TEST_PORT:-5001}/api"
TOKEN="dev-system-token-not-for-production"

for i in $(seq 2 "$K"); do
  name="test-manuscripts-w$i"
  user="test$i"

  if [ ! -d "$REPOS/$name" ] && [ -d "$REPOS/test-manuscripts" ]; then
    cp -r "$REPOS/test-manuscripts" "$REPOS/$name"
    echo "  copied fixture repo: $name"
  fi

  # Sentence IDs hash (text + ordinal + COMMIT + segmenter) and are globally
  # unique — a byte-identical repo copy would collide with worker 1 (or a
  # sibling copy) on every sentence and abort the migration. The server
  # resolves "HEAD" as the latest commit THAT TOUCHED THE MANUSCRIPT FILE,
  # so the uniquifying commit must touch test.manuscript: append a trailing
  # newline (whitespace — segmentation-invisible) plus a per-worker
  # .workerid file so each copy's commit hash is guaranteed distinct.
  # Idempotent: skipped once the copy's file-touching HEAD has diverged.
  if [ -d "$REPOS/$name/.git" ]; then
    last_msg=$(git -C "$REPOS/$name" log -1 --format=%s -- test.manuscript 2>/dev/null)
    if ! printf '%s' "$last_msg" | grep -q "worker fixture"; then
      echo "$i" > "$REPOS/$name/.workerid"
      printf '\n' >> "$REPOS/$name/test.manuscript"
      git -C "$REPOS/$name" -c user.name=fixture -c user.email=fixture@dev \
        add .workerid test.manuscript
      git -C "$REPOS/$name" -c user.name=fixture -c user.email=fixture@dev \
        commit -q -m "worker fixture $i (uniquifies sentence-id commit hash)"
      echo "  uniquified manuscript HEAD: $name"
    fi
  fi

  # Existing user/grant → non-2xx; that's fine (idempotent).
  curl -s -o /dev/null -X POST "$API/admin/users" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"username\":\"$user\",\"password\":\"test\"}"
  curl -s -o /dev/null -X POST "$API/admin/grants" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"username\":\"$user\",\"manuscript_name\":\"$name\"}"
done
echo "  workers provisioned (1..$K)"
