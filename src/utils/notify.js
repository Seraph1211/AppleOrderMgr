/**
 * 任务完成通知工具
 * @description 在任务完成后发出提示音和系统通知
 */

const { execSync } = require('child_process');

/**
 * 发送任务完成通知
 * @param {string} taskName - 任务名称
 * @param {string} status - 任务状态：success/error/info
 */
function notify(taskName = '任务完成', status = 'success') {
  const config = {
    success: {
      sound: 'Glass',
      icon: '✅',
      message: '任务完成'
    },
    error: {
      sound: 'Basso',
      icon: '❌',
      message: '任务失败'
    },
    info: {
      sound: 'Ping',
      icon: 'ℹ️',
      message: '任务通知'
    }
  };

  const { sound, icon, message } = config[status] || config.info;

  try {
    // macOS 系统通知和提示音
    if (process.platform === 'darwin') {
      // 方式1: 使用 osascript 发送通知（带声音）
      const script = `display notification "${taskName}" with title "${icon} ${message}" sound name "${sound}"`;
      execSync(`osascript -e '${script}'`, { stdio: 'pipe' });

      // 方式2: 直接播放提示音文件（备用方案，更可靠）
      try {
        execSync(`afplay /System/Library/Sounds/${sound}.aiff &`, { stdio: 'ignore' });
      } catch (soundError) {
        // 提示音播放失败，使用系统 beep
        execSync('osascript -e "beep 2"', { stdio: 'ignore' });
      }
    }

    // 终端提示（带颜色和响铃）
    console.log('\n\x07=========================================='); // \x07 是响铃字符
    console.log(`${icon} ${message}: ${taskName}`);
    console.log('==========================================\n');
  } catch (error) {
    // 忽略通知错误，不影响主流程
    console.log(`\n\x07${icon} ${message}: ${taskName}\n`);
  }
}

module.exports = { notify };

// 支持命令行调用
if (require.main === module) {
  const [taskName, status] = process.argv.slice(2);
  notify(taskName, status);
}
