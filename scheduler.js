/**
 * Docker 定时调度器。
 *
 * GitHub Actions 部署时由 workflow 的 schedule cron 触发签到；
 * Docker 部署改为容器内常驻调度：按 CRON_SCHEDULE 定时执行 main.js。
 *
 * 用法：
 *   node scheduler.js          常驻模式：按 CRON_SCHEDULE 定时签到（容器默认命令）
 *   node scheduler.js once     单次模式：立即执行一次签到后退出（docker compose run 使用）
 *   node scheduler.js next     打印接下来 3 次计划执行时间（校验调度配置用）
 */

import cron from 'node-cron'
import { spawn } from 'node:child_process'
import { printGreen, printMagenta, printRed, printYellow } from './utils/colorOut.js'

const SCHEDULE = process.env.CRON_SCHEDULE || '10 1 * * *' // 每天北京时间 01:10，与 Actions 的签到 cron 保持一致
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Shanghai'
const RUN_ON_STARTUP = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.RUN_ON_STARTUP || '').toLowerCase()
)

function nowStr() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date()).replaceAll('/', '-')
}

/** 执行一次签到（node main.js），返回退出码 */
function runCheckin() {
  return new Promise(resolve => {
    printMagenta(`[${nowStr()}] ──────────── 开始执行签到任务 ────────────`)
    const child = spawn(process.execPath, ['main.js'], { stdio: 'inherit' })
    child.on('error', err => {
      printRed(`[${nowStr()}] 签到进程启动失败：${err.message}`)
      resolve(1)
    })
    child.on('exit', code => {
      if (code === 0) {
        printGreen(`[${nowStr()}] 签到任务执行成功`)
      } else {
        printRed(`[${nowStr()}] 签到任务执行失败，退出码 ${code}（详见上方日志）`)
      }
      resolve(code ?? 1)
    })
  })
}

/** 打印接下来 n 次计划执行时间（用于校验 CRON_SCHEDULE 配置） */
function printUpcoming(n = 3) {
  // 仅支持 "分 时 * * *" 形式的精确预览，复杂表达式（含 */n、星期/日限定的）跳过
  const fields = SCHEDULE.trim().split(/\s+/)
  const [minute, hour] = fields
  if (
    fields.length !== 5 ||
    !/^\d+$/.test(minute) || !/^\d+$/.test(hour) ||
    fields.slice(2).some(f => f !== '*')
  ) return

  // 北京时间固定为 UTC+8（无夏令时），北京时间 hh:mm == UTC (hh-8):mm
  const full = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIMEZONE, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const now = new Date()
  const list = []
  for (let day = 0; list.length < n && day < 366; day++) {
    const t = Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(),
      now.getUTCDate() + day, Number(hour) - 8, Number(minute)
    )
    if (t > now.getTime()) list.push(full.format(new Date(t)))
  }
  for (const t of list) printYellow(`  下一次执行（${TIMEZONE}）：${t}`)
}

// ────────────────────────── 入口 ──────────────────────────

const mode = process.argv[2] || 'daemon'

if (mode === 'once') {
  runCheckin().then(code => process.exit(code))
} else if (mode === 'next') {
  printUpcoming()
} else {
  if (!cron.validate(SCHEDULE)) {
    printRed(`CRON_SCHEDULE 无效："${SCHEDULE}"，示例：'10 1 * * *'（每天 01:10）`)
    process.exit(1)
  }

  printGreen(`[${nowStr()}] kgcheckin 调度器已启动`)
  printYellow(`  计划任务：${SCHEDULE}（${TIMEZONE}）`)
  printYellow(`  凭据来源：${process.env.USERINFO_FILE || (process.env.USERINFO ? '环境变量 USERINFO' : '未配置！请设置 USERINFO 或挂载 USERINFO_FILE')}`)
  printUpcoming()
  printYellow(`  提示：docker compose run --rm kgcheckin node scheduler.js once 可手动立即签到`)

  let running = false
  const task = cron.schedule(SCHEDULE, async () => {
    if (running) {
      printYellow(`[${nowStr()}] 上一次签到任务尚未结束，跳过本次触发`)
      return
    }
    running = true
    try {
      await runCheckin()
    } finally {
      running = false
    }
  }, { timezone: TIMEZONE })

  if (RUN_ON_STARTUP) {
    printYellow(`[${nowStr()}] RUN_ON_STARTUP=true，容器启动后立即执行一次签到`)
    runCheckin()
  }

  const shutdown = sig => {
    printYellow(`[${nowStr()}] 收到 ${sig}，停止调度器...`)
    task.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
