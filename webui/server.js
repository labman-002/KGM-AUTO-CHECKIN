/**
 * kgcheckin WebUI 服务。
 *
 * 容器内一体化运行：
 *   - Web 控制台（扫码登录 / 手机号登录 / 一键签到 / 账号管理）
 *   - 内置定时调度（node-cron，替代独立 scheduler 进程）
 *   - 常驻酷狗 API 服务子进程（端口 WEBUI_API_PORT，懒启动 + 空闲自动关闭）供登录类操作使用
 *   - 签到任务以子进程运行 main.js，其 API 服务使用独立端口 CHECKIN_API_PORT，与登录服务互不冲突
 *
 * 环境变量：
 *   WEBUI_PORT        Web 控制台监听端口（默认 3000）
 *   WEBUI_PASSWORD    可选访问密码；设置后所有 /api/* 需携带 X-WebUI-Key 头（或 ?key= 查询参数，供 SSE 使用）
 *   WEBUI_API_PORT    登录用 API 服务端口（默认 3010）
 *   CHECKIN_API_PORT  签到子进程 API 服务端口（默认 3020）
 *   CRON_SCHEDULE     签到计划任务（默认 "10 1 * * *"，每天北京时间 01:10）
 *   CRON_TIMEZONE     调度时区（默认 Asia/Shanghai）
 *   RUN_ON_STARTUP    "true" 时容器启动后立即执行一次签到
 *   USERINFO_FILE     凭据文件路径（Docker 镜像默认 /app/data/userinfo.json）
 */

import express from 'express'
import cron from 'node-cron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

import { close_api, delay, send, startService, waitForApi } from '../utils/utils.js'
import { upsertUser, writeUserinfoFile, parseUserinfoJson } from '../utils/userinfo.js'
import { maskIdentifier } from '../utils/safeLog.js'
import { printGreen, printMagenta, printRed, printYellow } from '../utils/colorOut.js'

const require = createRequire(import.meta.url)
const QRCode = require('qrcode')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ────────────────────────── 配置 ──────────────────────────

const WEBUI_PORT = Number(process.env.WEBUI_PORT || 3000)
const WEBUI_PASSWORD = String(process.env.WEBUI_PASSWORD || '').trim()
const WEBUI_API_PORT = process.env.WEBUI_API_PORT || '3010'
const CHECKIN_API_PORT = process.env.CHECKIN_API_PORT || '3020'
const SCHEDULE = process.env.CRON_SCHEDULE || '10 1 * * *'
const TIMEZONE = process.env.CRON_TIMEZONE || 'Asia/Shanghai'
const RUN_ON_STARTUP = ['1', 'true', 'yes', 'on'].includes(String(process.env.RUN_ON_STARTUP || '').toLowerCase())
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000

// 本进程内 utils（startService/send/waitForApi）统一使用登录专用端口
process.env.API_PORT = WEBUI_API_PORT
if (!process.env.USERINFO_FILE) {
  process.env.USERINFO_FILE = path.join(ROOT, 'data', 'userinfo.json')
}
const USERINFO_FILE = process.env.USERINFO_FILE

const BOOT_AT = new Date().toISOString()

// ────────────────────────── 凭据文件 ──────────────────────────

function readUserinfo() {
  try {
    // parseUserinfoJson 兼容 UTF-8 BOM（Windows 记事本保存的文件）
    return parseUserinfoJson(fs.readFileSync(USERINFO_FILE, 'utf8')) || []
  } catch {
    return []
  }
}

function readUserinfoRaw() {
  try {
    // 去除 BOM 后作为整体文本传给签到子进程（main.js 侧亦有兜底解析）
    return fs.readFileSync(USERINFO_FILE, 'utf8').replace(/^\uFEFF/, '').trim()
  } catch {
    return ''
  }
}

function saveUserinfo(arr) {
  return writeUserinfoFile(JSON.stringify(arr))
}

// ────────────────────────── 登录用 API 服务管理 ──────────────────────────
// 懒启动 + 引用计数 + 空闲超时自动关闭；登录操作按请求短暂持有。

const loginApi = {
  child: null,
  refCount: 0,
  idleTimer: null,
  starting: null,

  async acquire() {
    if (this.starting) await this.starting
    if (!this.child) {
      this.starting = (async () => {
        printYellow(`[webui] 启动本地 API 服务 (port ${WEBUI_API_PORT})...`)
        const child = startService()
        try {
          await waitForApi(undefined, 30000)
        } catch (e) {
          close_api(child)
          throw e
        }
        this.child = child
        printGreen('[webui] 本地 API 服务已就绪')
      })()
      try {
        await this.starting
      } finally {
        this.starting = null
      }
    }
    this.refCount++
    clearTimeout(this.idleTimer)
  },

  release() {
    this.refCount = Math.max(0, this.refCount - 1)
    if (this.refCount === 0) {
      clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.shutdown(), IDLE_SHUTDOWN_MS)
    }
  },

  shutdown() {
    if (!this.child) return
    close_api(this.child)
    this.child = null
    printYellow('[webui] 本地 API 服务空闲，已关闭')
  },

  running() {
    return Boolean(this.child)
  },
}

/** 在持有 API 服务期间执行 fn（自动获取/释放） */
async function withApi(fn) {
  await loginApi.acquire()
  try {
    return await fn()
  } finally {
    loginApi.release()
  }
}

// ────────────────────────── 签到任务 ──────────────────────────

const LOG_BUFFER_MAX = 800
const checkinState = {
  running: false,
  lastRun: null, // { startedAt, endedAt, exitCode, ok, trigger }
  logs: [],      // 环形缓冲 { ts, level, text }，text 含原始 ANSI 转义
  sseClients: new Set(),
}

function pushLog(level, text) {
  const entry = { ts: new Date().toISOString(), level, text }
  checkinState.logs.push(entry)
  if (checkinState.logs.length > LOG_BUFFER_MAX) {
    checkinState.logs.splice(0, checkinState.logs.length - LOG_BUFFER_MAX)
  }
  // 同步镜像到容器 stdout，保证 docker compose logs 也能看到签到明细
  console.log(`[checkin] ${text}`)
  const payload = `data: ${JSON.stringify(entry)}\n\n`
  for (const client of checkinState.sseClients) {
    try { client.write(payload) } catch { /* 断开的连接在 close 时清理 */ }
  }
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of checkinState.sseClients) {
    try { client.write(payload) } catch { /* ignore */ }
  }
}

/**
 * 启动一次签到子进程（node main.js）。
 * 子进程通过 API_PORT 使用独立端口拉起自己的 API 服务，与登录服务互不冲突；
 * 凭据优先取挂载卷文件内容，其次继承环境变量 USERINFO。
 */
function startCheckin(trigger = 'manual') {
  if (checkinState.running) return false

  checkinState.running = true
  const startedAt = new Date().toISOString()
  checkinState.lastRun = { startedAt, trigger, running: true }

  pushLog('sys', `────── 签到任务开始（${trigger === 'cron' ? '定时调度' : trigger === 'startup' ? '启动触发' : '手动触发'} · ${startedAt}）──────`)
  broadcast('start', checkinState.lastRun)

  const env = { ...process.env, API_PORT: CHECKIN_API_PORT }
  const userinfoRaw = readUserinfoRaw()
  if (userinfoRaw) {
    env.USERINFO = userinfoRaw
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'main.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const onStream = buf => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (line.trim()) pushLog('log', line)
    }
  }
  child.stdout.on('data', onStream)
  child.stderr.on('data', onStream)

  child.on('error', err => {
    pushLog('err', `签到进程启动失败：${err.message}`)
  })

  child.on('exit', code => {
    const exitCode = code ?? 1
    checkinState.running = false
    checkinState.lastRun = {
      ...checkinState.lastRun,
      endedAt: new Date().toISOString(),
      exitCode,
      ok: exitCode === 0,
      running: false,
    }
    pushLog(exitCode === 0 ? 'ok' : 'err', `────── 签到任务结束（退出码 ${exitCode}）──────`)
    broadcast('end', checkinState.lastRun)
  })

  return true
}

// ────────────────────────── 计划预览 ──────────────────────────

/** 预览 "分 时 * * *" 形式的 cron 接下来 n 次执行时间（北京时间固定 UTC+8） */
function nextRuns(n = 3) {
  const fields = SCHEDULE.trim().split(/\s+/)
  const [minute, hour] = fields
  if (
    fields.length !== 5 ||
    !/^\d+$/.test(minute) || !/^\d+$/.test(hour) ||
    fields.slice(2).some(f => f !== '*')
  ) return []

  const fmt = new Intl.DateTimeFormat('zh-CN', {
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
    if (t > now.getTime()) list.push(fmt.format(new Date(t)))
  }
  return list
}

// ────────────────────────── Express 应用 ──────────────────────────

const app = express()
app.disable('x-powered-by')
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// 可选访问密码：/api/* 需要 X-WebUI-Key 头（SSE 可用 ?key= 查询参数）
app.use('/api', (req, res, next) => {
  if (!WEBUI_PASSWORD) return next()
  const key = req.headers['x-webui-key'] || req.query.key
  if (key === WEBUI_PASSWORD) return next()
  return res.status(401).json({ error: '未授权：请在页面右上角输入访问密码' })
})

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

/** 校验酷狗手机号格式 */
function assertPhone(phone) {
  if (!/^1[3-9]\d{9}$/.test(String(phone || ''))) {
    const err = new Error('手机号格式不正确')
    err.status = 400
    throw err
  }
}

// ── 状态 ──
app.get('/api/status', wrap(async (req, res) => {
  res.json({
    bootAt: BOOT_AT,
    schedule: {
      cron: SCHEDULE,
      timezone: TIMEZONE,
      valid: cron.validate(SCHEDULE),
      nextRuns: nextRuns(3),
    },
    checkin: {
      running: checkinState.running,
      lastRun: checkinState.lastRun,
    },
    accounts: readUserinfo().map((u, i) => ({
      index: i,
      userid: maskIdentifier(u.userid),
      tokenLength: String(u.token || '').length,
    })),
    apiServiceRunning: loginApi.running(),
  })
}))

// ── 扫码登录 ──
app.post('/api/qr/gen', wrap(async (req, res) => {
  const number = Math.min(5, Math.max(1, parseInt(req.body?.number, 10) || 1))
  const items = []
  await withApi(async () => {
    for (let n = 0; n < number; n++) {
      const r = await send(`/login/qr/key?timestrap=${Date.now()}`, 'GET', {})
      if (r?.status !== 1 || !r?.data?.qrcode) {
        const err = new Error(`获取二维码密钥失败（status=${r?.status ?? 'unknown'}）`)
        err.status = 502
        throw err
      }
      const key = r.data.qrcode
      const url = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`
      const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 })
      items.push({ key, url, dataUrl })
      if (number > 1 && n < number - 1) await delay(500)
    }
  })
  printMagenta(`[webui] 已生成 ${items.length} 个登录二维码，等待扫码...`)
  res.json({ items })
}))

app.get('/api/qr/status', wrap(async (req, res) => {
  const key = String(req.query.key || '').trim()
  if (!key) {
    const err = new Error('缺少 qrcode key')
    err.status = 400
    throw err
  }
  const result = await withApi(async () => {
    const r = await send(`/login/qr/check?key=${encodeURIComponent(key)}&timestrap=${Date.now()}`, 'GET', {})
    const s = r?.data?.status
    if (s === 4 && r?.data?.userid && r?.data?.token) {
      // 登录成功：凭据写入挂载卷（追加/更新，不动已有账号）
      const arr = readUserinfo()
      upsertUser(arr, { userid: String(r.data.userid), token: String(r.data.token) }, true)
      const saved = saveUserinfo(arr)
      return { status: 4, userid: maskIdentifier(r.data.userid), saved }
    }
    return { status: s ?? -1 }
  })
  if (result.status === 4) {
    printGreen(`[webui] 扫码登录成功，账号 ${result.userid} 已${result.saved ? '保存到凭据文件' : '获取（写文件失败）'}`)
  }
  res.json(result)
}))

// ── 手机号登录 ──
app.post('/api/phone/send', wrap(async (req, res) => {
  const phone = String(req.body?.phone || '').trim()
  assertPhone(phone)
  const r = await withApi(() => send(`/captcha/sent?mobile=${phone}`, 'GET', {}))
  if (r?.status !== 1) {
    const err = new Error(`验证码发送失败：${r?.msg || r?.message || `status=${r?.status ?? 'unknown'}`}`)
    err.status = 502
    throw err
  }
  printGreen(`[webui] 验证码已发送至 ${phone.slice(0, 2)}*******${phone.slice(-2)}`)
  res.json({ ok: true })
}))

app.post('/api/phone/login', wrap(async (req, res) => {
  const phone = String(req.body?.phone || '').trim()
  const code = String(req.body?.code || '').trim()
  assertPhone(phone)
  if (!/^\d{4,6}$/.test(code)) {
    const err = new Error('验证码格式不正确')
    err.status = 400
    throw err
  }
  const r = await withApi(() => send(`/login/cellphone?mobile=${phone}&code=${code}`, 'GET', {}))
  if (r?.status === 1 && r?.data?.userid && r?.data?.token) {
    const arr = readUserinfo()
    upsertUser(arr, { userid: String(r.data.userid), token: String(r.data.token) }, true)
    const saved = saveUserinfo(arr)
    const userid = maskIdentifier(r.data.userid)
    printGreen(`[webui] 手机号登录成功，账号 ${userid} 已保存`)
    return res.json({ ok: true, userid, saved })
  }
  if (r?.error_code === 34175) {
    const err = new Error('该手机号绑定了多个酷狗账号，暂不支持手机号登录，请使用扫码登录')
    err.status = 400
    throw err
  }
  const err = new Error(`登录失败：${r?.msg || r?.message || `status=${r?.status ?? 'unknown'}`}`)
  err.status = 401
  throw err
}))

// ── 一键签到 ──
app.post('/api/checkin/run', wrap(async (req, res) => {
  if (checkinState.running) {
    const err = new Error('签到任务正在进行中，请稍候')
    err.status = 409
    throw err
  }
  const accounts = readUserinfo()
  if (!accounts.length && !process.env.USERINFO) {
    const err = new Error('尚未配置任何账号凭据，请先登录')
    err.status = 400
    throw err
  }
  startCheckin('manual')
  res.status(202).json({ ok: true })
}))

app.get('/api/checkin/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(`event: hello\ndata: ${JSON.stringify({
    running: checkinState.running,
    lastRun: checkinState.lastRun,
    replayed: checkinState.logs.length,
  })}\n\n`)
  for (const entry of checkinState.logs) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`)
  }
  checkinState.sseClients.add(res)
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n') } catch { /* ignore */ }
  }, 15000)
  req.on('close', () => {
    clearInterval(heartbeat)
    checkinState.sseClients.delete(res)
  })
})

// ── 账号管理 ──
app.delete('/api/accounts/:index', wrap(async (req, res) => {
  const index = parseInt(req.params.index, 10)
  const arr = readUserinfo()
  if (!Number.isInteger(index) || index < 0 || index >= arr.length) {
    const err = new Error('账号序号不存在')
    err.status = 404
    throw err
  }
  const removed = maskIdentifier(arr[index].userid)
  arr.splice(index, 1)
  saveUserinfo(arr)
  printYellow(`[webui] 已删除账号 ${removed}，剩余 ${arr.length} 个账号`)
  res.json({ ok: true, remaining: arr.length })
}))

// ── 兜底 ──
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }))
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500
  if (status >= 500) printRed(`[webui] ${req.method} ${req.path} 失败：${err.message}`)
  res.status(status).json({ error: err.message })
})

// ────────────────────────── 启动 ──────────────────────────

const BANNER = `
  ┌─────────────────────────────────────┐
  │   kgcheckin webui  ·  酷狗概念签到   │
  └─────────────────────────────────────┘`

app.listen(WEBUI_PORT, () => {
  console.log(BANNER)
  printGreen(`[webui] 控制台已启动: http://127.0.0.1:${WEBUI_PORT}`)
  printYellow(`  计划任务: ${cron.validate(SCHEDULE) ? SCHEDULE : `${SCHEDULE} (无效！定时签到未启用)`}（${TIMEZONE}）`)
  printYellow(`  下次执行: ${nextRuns(1)[0] || '-'}`)
  printYellow(`  凭据文件: ${USERINFO_FILE}（${readUserinfo().length} 个账号）`)
  printYellow(`  访问密码: ${WEBUI_PASSWORD ? '已启用' : '未启用（仅建议在可信内网使用）'}`)

  if (cron.validate(SCHEDULE)) {
    cron.schedule(SCHEDULE, () => {
      if (checkinState.running) {
        printYellow('[webui] 上一次签到任务尚未结束，跳过本次定时触发')
        return
      }
      startCheckin('cron')
    }, { timezone: TIMEZONE })
  }

  if (RUN_ON_STARTUP) {
    printYellow('[webui] RUN_ON_STARTUP=true，即将执行一次启动签到')
    setTimeout(() => startCheckin('startup'), 2000)
  }
})
