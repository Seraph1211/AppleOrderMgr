#!/bin/sh
# Git pre-commit hook - 文档一致性检查
#
# 安装方法：
#   chmod +x scripts/pre-commit-check.sh
#   ln -sf ../../scripts/pre-commit-check.sh .git/hooks/pre-commit
#
# 或使用 husky:
#   npm install husky --save-dev
#   npx husky install
#   npx husky add .git/hooks/pre-commit "bash scripts/pre-commit-check.sh"

echo "🔍 运行 pre-commit 检查..."

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查是否修改了 Model 文件
MODEL_MODIFIED=$(git diff --cached --name-only | grep "src/models/")
SCHEMA_MODIFIED=$(git diff --cached --name-only | grep "docs/database/SCHEMA.md")

if [ -n "$MODEL_MODIFIED" ]; then
  echo "📦 检测到 Model 文件变更："
  echo "$MODEL_MODIFIED"

  if [ -z "$SCHEMA_MODIFIED" ]; then
    echo ""
    echo "${RED}❌ 错误: 修改了 Model 文件但未更新 docs/database/SCHEMA.md${NC}"
    echo ""
    echo "📋 级联更新规则："
    echo "  1. 先更新权威文档 docs/database/SCHEMA.md"
    echo "  2. 然后更新 src/models/*.js"
    echo "  3. 创建 Migration 文件"
    echo "  4. 更新测试用例"
    echo "  5. 更新 docs/development/DEVELOPMENT_PROGRESS.md"
    echo ""
    echo "💡 提示: 查看 CLAUDE.md 中的'文件变更级联规则'章节"
    echo ""
    exit 1
  else
    echo "${GREEN}✅ 已更新 SCHEMA.md${NC}"
  fi
fi

# 检查是否修改了 API Controller
CONTROLLER_MODIFIED=$(git diff --cached --name-only | grep "src/controllers/")
API_DOC_MODIFIED=$(git diff --cached --name-only | grep "docs/design/api-design.md")

if [ -n "$CONTROLLER_MODIFIED" ]; then
  echo "🔌 检测到 Controller 文件变更："
  echo "$CONTROLLER_MODIFIED"

  if [ -z "$API_DOC_MODIFIED" ]; then
    echo ""
    echo "${YELLOW}⚠️  警告: 修改了 Controller 但未更新 docs/design/api-design.md${NC}"
    echo ""
    echo "💡 如果涉及 API 接口变更，请同时更新 API 文档"
    echo ""
    # 这里只是警告，不阻止提交
  else
    echo "${GREEN}✅ 已更新 API 文档${NC}"
  fi
fi

# 检查是否更新了 DEVELOPMENT_PROGRESS.md
PROGRESS_MODIFIED=$(git diff --cached --name-only | grep "docs/development/DEVELOPMENT_PROGRESS.md")
CODE_MODIFIED=$(git diff --cached --name-only | grep -E "\.(js|ts)$" | grep -v "test/")

if [ -n "$CODE_MODIFIED" ] && [ -z "$PROGRESS_MODIFIED" ]; then
  echo ""
  echo "${YELLOW}⚠️  提醒: 修改了代码但未更新开发进度文档${NC}"
  echo ""
  echo "💡 建议在完成开发后更新 docs/development/DEVELOPMENT_PROGRESS.md"
  echo ""
  # 这里只是提醒，不阻止提交
fi

# 运行文档一致性检查（如果 src/models 存在）
if [ -d "src/models" ] && [ -n "$MODEL_MODIFIED" ]; then
  echo ""
  echo "🔍 运行文档一致性检查..."

  if node scripts/check-doc-consistency.js; then
    echo "${GREEN}✅ 文档一致性检查通过${NC}"
  else
    echo ""
    echo "${RED}❌ 文档一致性检查失败${NC}"
    echo ""
    echo "💡 请修复上述问题后再提交"
    echo ""
    exit 1
  fi
fi

# 运行代码规范检查
echo ""
echo "🔍 运行代码规范检查..."

if npm run lint --silent; then
  echo "${GREEN}✅ 代码规范检查通过${NC}"
else
  echo ""
  echo "${RED}❌ 代码规范检查失败${NC}"
  echo ""
  echo "💡 运行 'npm run lint:fix' 自动修复部分问题"
  echo ""
  exit 1
fi

echo ""
echo "${GREEN}✅ 所有 pre-commit 检查通过${NC}"
echo ""

exit 0
