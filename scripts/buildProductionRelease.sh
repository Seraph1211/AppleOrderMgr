#!/usr/bin/env bash
set -euo pipefail
umask 077

command -v python3 >/dev/null || { echo '生产前端门禁需要 Python 3.6+' >&2; exit 1; }

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "必须在本地 main 分支构建生产制品" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# 先核对已发布能力，不能因工作树干净就把缺少生产增量的旧源码再次发布。
python3 scripts/productionSourceGuard.py source --root "$repo_root" >&2

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
frontend_source_dir="${PRODUCTION_FRONTEND_SOURCE_DIR:-}"
frontend_source_mode="built"
frontend_version="${PRODUCTION_FRONTEND_VERSION:-$release_id}"

mkdir -p "$release_dir/frontend"
python3 scripts/productionSourceGuard.py source --root "$repo_root" \
  --output "$release_dir/source-capabilities.json" >&2

docker buildx build \
  --platform linux/amd64 \
  --build-arg "NODE_IMAGE=$node_image" \
  --target runtime \
  --tag "$runtime_image" \
  --load \
  .

python3 scripts/productionSourceGuard.py runtime --image "$runtime_image" \
  --manifest "$release_dir/source-capabilities.json" \
  --output "$release_dir/runtime-source-proof.json" >&2

docker buildx build \
  --platform linux/amd64 \
  --build-arg "NODE_IMAGE=$node_image" \
  --target migrator \
  --tag "$migrator_image" \
  --load \
  .

if [[ -n "$frontend_source_dir" ]]; then
  if [[ "$frontend_source_dir" != /* || ! -d "$frontend_source_dir" || -L "$frontend_source_dir" ]]; then
    echo "PRODUCTION_FRONTEND_SOURCE_DIR 必须是已核验的绝对普通目录" >&2
    exit 1
  fi
  if [[ -z "${PRODUCTION_FRONTEND_VERSION:-}" || "$frontend_version" =~ [^A-Za-z0-9._-] ]]; then
    echo "保全生产前端时必须提供仅含字母、数字、点、下划线或连字符的 PRODUCTION_FRONTEND_VERSION" >&2
    exit 1
  fi
  frontend_source_mode="preserved-production-bytes"
  cp -a "$frontend_source_dir/." "$release_dir/frontend/"
  if [[ ! -f "$frontend_source_dir/../capabilities.json" ]]; then
    echo '保全生产前端时必须同时保全 capabilities.json' >&2
    exit 1
  fi
  cp "$frontend_source_dir/../capabilities.json" "$release_dir/capabilities.json"
else
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
  python3 scripts/productionSourceGuard.py frontend --root "$repo_root" \
    --release "$release_dir" --output "$release_dir/capabilities.json" >&2
fi

frontend_tree_digest="$({
  cd "$release_dir/frontend"
  find . -type f -print0 | sort -z | xargs -0 shasum -a 256
} | shasum -a 256 | awk '{print $1}')"

# 显式 chmod 不受调用方 umask 077 影响；只处理公开树，不放宽私密文件。
python3 scripts/productionFrontendGate.py prepare "$release_dir" >&2
python3 scripts/productionFrontendGate.py check "$release_dir" --permissions-only >&2
cp scripts/productionFrontendGate.py "$release_dir/productionFrontendGate.py"
cp scripts/productionSourceGuard.py "$release_dir/productionSourceGuard.py"
cp scripts/productionRelease.py "$release_dir/productionRelease.py"
cp scripts/productionReleaseBackup.py "$release_dir/productionReleaseBackup.py"
cp scripts/productionReleaseFiles.py "$release_dir/productionReleaseFiles.py"
cp scripts/productionReleaseResourceProbe.py \
  "$release_dir/productionReleaseResourceProbe.py"
cp scripts/productionReleaseDatabaseValidation.sql \
  "$release_dir/productionReleaseDatabaseValidation.sql"
cp scripts/productionReleaseSchemaDiagnostic.sql \
  "$release_dir/productionReleaseSchemaDiagnostic.sql"
cp scripts/productionReleaseSchemaInventory.sql \
  "$release_dir/productionReleaseSchemaInventory.sql"

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
  "frontendApiBaseUrl": "/api",
  "frontendSourceMode": "$frontend_source_mode",
  "frontendVersion": "$frontend_version",
  "frontendTreeDigest": "$frontend_tree_digest",
  "releaseExecutor": "productionRelease.py",
  "releaseBackupTool": "productionReleaseBackup.py",
  "releaseFilesTool": "productionReleaseFiles.py",
  "releaseResourceProbe": "productionReleaseResourceProbe.py",
  "databaseValidationSql": "productionReleaseDatabaseValidation.sql",
  "schemaDiagnosticSql": "productionReleaseSchemaDiagnostic.sql",
  "schemaInventorySql": "productionReleaseSchemaInventory.sql"
}
MANIFEST

(
  cd "$release_dir"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS
)

printf '%s\n' "$release_dir"
