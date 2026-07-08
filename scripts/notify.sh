#!/bin/bash

###############################################################################
# 任务完成通知脚本
# 功能：在任务完成后发出提示音并显示通知
# 使用：./scripts/notify.sh "任务名称" "任务状态"
###############################################################################

TASK_NAME="${1:-任务完成}"
STATUS="${2:-success}"

# 根据状态选择提示音和图标
if [ "$STATUS" = "success" ]; then
    SOUND="Glass"  # 成功音效
    ICON="✅"
    MESSAGE="任务完成"
elif [ "$STATUS" = "error" ]; then
    SOUND="Basso"  # 错误音效
    ICON="❌"
    MESSAGE="任务失败"
else
    SOUND="Ping"   # 默认音效
    ICON="ℹ️"
    MESSAGE="任务通知"
fi

# 播放提示音（macOS）
if command -v afplay &> /dev/null; then
    afplay /System/Library/Sounds/${SOUND}.aiff &
fi

# 显示通知（macOS）
if command -v osascript &> /dev/null; then
    osascript -e "display notification \"$TASK_NAME\" with title \"$ICON $MESSAGE\" sound name \"${SOUND}\""
fi

# 终端提示
echo ""
echo "=========================================="
echo "$ICON $MESSAGE: $TASK_NAME"
echo "=========================================="
echo ""
