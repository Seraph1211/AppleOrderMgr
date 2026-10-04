#!/usr/bin/env bash
# PP_CloudServer 已安装隔离环境的单笔入口。只读业务数据；无宿主浏览器依赖。
set -euo pipefail
umask 077
TASK_ROOT=${OFFICIAL_ORDER_ROOT:-/var/www/apple-order-mgr/shared/official-orders}
ORDER_ID=${1:-}
RESUME_RUN=${2:-}
if [[ ! "$ORDER_ID" =~ ^[1-9][0-9]*$ ]] || [[ -n "$RESUME_RUN" && ! "$RESUME_RUN" =~ ^[1-9][0-9]*$ ]]; then
  echo 'Usage: runOfficialOrderServer.sh SYSTEM_ORDER_ID [SERVER_RESEARCH_RUN]' >&2
  exit 1
fi
exec 9>"$TASK_ROOT/private/collector.lock"
flock -n 9 || { echo 'COLLECTOR_BUSY' >&2; exit 2; }
COLLECTOR_NAME=apple-official-order-collector
COLLECTOR_IMAGE=mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
if docker inspect "$COLLECTOR_NAME" >/dev/null 2>&1; then
  if [[ $(docker inspect --format '{{.State.Running}}' "$COLLECTOR_NAME") == true ]]; then
    echo 'COLLECTOR_BUSY' >&2
    exit 2
  fi
  docker rm "$COLLECTOR_NAME" >/dev/null
fi
INPUT_FILE="$TASK_ROOT/private/request-$ORDER_ID.json"
INPUT_TEMP=$(mktemp "$TASK_ROOT/private/request-$ORDER_ID.XXXXXX")
if docker exec -i -e OFFICIAL_ORDER_ID="$ORDER_ID" apple-order-mgr-prod-api-1 node \
  < "$TASK_ROOT/release/scripts/readOfficialOrderInput.js" > "$INPUT_TEMP"; then
  chmod 600 "$INPUT_TEMP"
  chown 1000:1000 "$INPUT_TEMP"
  mv "$INPUT_TEMP" "$INPUT_FILE"
else
  rm -f "$INPUT_TEMP"
  exit 1
fi
docker create --init --name "$COLLECTOR_NAME" --network apple-account-research-internal \
  --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 1024m --cpus 1 --pids-limit 256 --shm-size 256m \
  --tmpfs /tmp:rw,nosuid,size=268435456 -e HOME=/tmp -e NODE_PATH=/research/node_modules \
  -v "$TASK_ROOT:/research:rw" \
  -v "$TASK_ROOT/deps:/research/node_modules:ro" \
  --entrypoint xvfb-run "$COLLECTOR_IMAGE" -a -s '-screen 0 1365x900x24' \
  node /research/release/scripts/collectOfficialOrder.js /research "$ORDER_ID" "$RESUME_RUN" >/dev/null
docker network connect apple-account-research-egress "$COLLECTOR_NAME"
docker start "$COLLECTOR_NAME" >/dev/null
python "$TASK_ROOT/release/scripts/watchOfficialOrderServer.py" "$COLLECTOR_NAME" \
  > "$TASK_ROOT/evidence/collector-watch-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
docker logs "$COLLECTOR_NAME"
exit "$(docker inspect --format '{{.State.ExitCode}}' "$COLLECTOR_NAME")"
