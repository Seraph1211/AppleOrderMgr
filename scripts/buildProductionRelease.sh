#!/usr/bin/env bash
set -euo pipefail

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "必须在本地 main 分支构建生产制品" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

source_commit="$(git rev-parse HEAD)"
temporary_index="$(mktemp)"
trap 'rm -f "$temporary_index"; if [[ -n "${frontend_container:-}" ]]; then docker rm -f "$frontend_container" >/dev/null 2>&1 || true; fi' EXIT
rm -f "$temporary_index"
GIT_INDEX_FILE="$temporary_index" git read-tree HEAD
GIT_INDEX_FILE="$temporary_index" git add -A
source_tree="$(GIT_INDEX_FILE="$temporary_index" git write-tree)"
short_tree="${source_tree:0:12}"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${short_tree}"
release_dir="$repo_root/release-artifacts/$release_id"
runtime_image="apple-order-mgr-runtime:${release_id}-amd64"
migrator_image="apple-order-mgr-migrator:${release_id}-amd64"
frontend_image="apple-order-mgr-frontend-builder:${release_id}-amd64"
node_image="${PRODUCTION_NODE_IMAGE:-node:20-alpine}"

mkdir -p "$release_dir/frontend"

docker buildx build \
  --platform linux/amd64 \
  --build-arg "NODE_IMAGE=$node_image" \
  --target runtime \
  --tag "$runtime_image" \
  --load \
  .

docker buildx build \
  --platform linux/amd64 \
  --build-arg "NODE_IMAGE=$node_image" \
  --target migrator \
  --tag "$migrator_image" \
  --load \
  .

docker buildx build \
  --platform linux/amd64 \
  --build-arg "NODE_IMAGE=$node_image" \
  --build-arg VITE_API_BASE_URL=/api \
  --file frontend/Dockerfile.prod \
  --tag "$frontend_image" \
  --load \
  frontend

frontend_container="$(docker create "$frontend_image")"
docker cp "$frontend_container:/app/dist/." "$release_dir/frontend/"
docker rm "$frontend_container" >/dev/null
frontend_container=""

docker save "$runtime_image" "$migrator_image" | gzip -9 > "$release_dir/images.tar.gz"
cp docker-compose.prod.yml "$release_dir/docker-compose.prod.yml"
cp nginx-apple-order-mgr.conf "$release_dir/nginx-apple-order-mgr.conf"
cat > "$release_dir/release.env" <<RELEASE_ENV
RUNTIME_IMAGE=$runtime_image
MIGRATOR_IMAGE=$migrator_image
APP_ENV_FILE=/var/www/apple-order-mgr/shared/app.env
API_BIND_ADDRESS=127.0.0.1
API_HOST_PORT=3001
RELEASE_ENV

git ls-files -co --exclude-standard -z |
  while IFS= read -r -d '' source_file; do
    if [[ -e "$source_file" ]]; then
      printf '%s\0' "$source_file"
    fi
  done |
  tar --null -czf "$release_dir/source-tree.tar.gz" --files-from -
git status --short > "$release_dir/source-status.txt"

cat > "$release_dir/manifest.json" <<MANIFEST
{
  "releaseId": "$release_id",
  "builtAtUtc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "branch": "main",
  "sourceCommit": "$source_commit",
  "sourceTree": "$source_tree",
  "workingTreeClean": $(if [[ -z "$(git status --porcelain)" ]]; then echo true; else echo false; fi),
  "platform": "linux/amd64",
  "runtimeImage": "$runtime_image",
  "migratorImage": "$migrator_image",
  "frontendApiBaseUrl": "/api"
}
MANIFEST

(
  cd "$release_dir"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS
)

printf '%s\n' "$release_dir"
