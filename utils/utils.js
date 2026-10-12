import { spawn } from 'child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../api')

/**
 * 本地 api 服务端口。
 * 通过环境变量 API_PORT 覆盖（默认 3000），供 Docker WebUI 等场景
 * 在同一容器内并行运行多个 api 服务实例（登录服务 / 签到子进程各用一个端口）。
 * 注意需在调用时读取（而非模块加载时），调用方可能在导入后才设置该变量。
 */
function apiPort() {
  return process.env.API_PORT || '3000'
}

function apiBase() {
  return `http://127.0.0.1:${apiPort()}`
}

/** 延时 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 等待本地 api 服务就绪（启动竞态修复）。
 * 原先各脚本在 startService() 后盲目 delay(2000)，
 * 在冷启动的 Actions runner 上可能因服务未就绪导致首个请求失败/超时。
 * 改为轮询探测：服务端口可响应任意 HTTP 即视为就绪，最多等待 timeoutMs。
 * @param {string} base 服务地址
 * @param {number} timeoutMs 最长等待毫秒
 */
async function waitForApi(base = apiBase(), timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      const resp = await fetch(base + '/user/detail', { method: 'GET', signal: controller.signal })
      clearTimeout(timer)
      // 任意 HTTP 响应（含 4xx/5xx）都说明服务已在监听端口
      return true
    } catch (err) {
      // 连接被拒（ECONNREFUSED）等服务尚未就绪，稍后重试
      await delay(500)
    }
  }
  throw new Error(`本地 API 服务在 ${timeoutMs}ms 内未就绪`)
}

/** 启动 api 服务（detached 使其成为独立进程组，便于整组强杀） */
function startService() {
  // 直接以 node 运行 api/app.js（与 npm run apiService → node app.js 等价）：
  // 1. 兼容 Windows：新版 Node 禁止无 shell 直接 spawn npm.cmd（EINVAL）；
  // 2. 少一层 npm 中间进程，close_api 强杀更干净（npm 不向子进程转发信号）。
  const api = spawn(process.execPath, ['app.js'], {
    cwd: apiDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // api 服务监听端口与客户端 base 保持一致（api/server.js 读取 PORT）
    env: { ...process.env, PORT: apiPort() },
  })

  api.stdout.on('data', () => {})
  api.stderr.on('data', data => {
    const msg = String(data).trim()
    if (msg) console.log('[api stderr]', msg)
  })
  api.on('close', code => console.log(`[api] 子进程退出，code=${code}`))

  return api
}

/**
 * 关闭 api 服务。
 * detached 使 api 服务运行在独立进程组：
 * - Linux（Actions/Docker）：process.kill(-pid, 'SIGKILL') 强杀整组；
 * - Windows：进程组不可用，降级为 api.kill() 直接结束服务进程。
 */
function close_api(api) {
  if (!api || !api.pid) return
  try {
    process.kill(-api.pid, 'SIGKILL') // 杀掉整个进程组（Linux/macOS）
  } catch (e) {
    try { api.kill('SIGKILL') } catch (_) { /* 已退出 */ }
  }
}

/**
 * 发送请求到本地 api 服务（带超时 + 重试）
 * 超时 10 秒，失败后指数退避重试最多 3 次
 */
async function send(path, method, headers) {
  const MAX_RETRIES = 3
  const TIMEOUT_MS = 10000
  let lastError

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const resp = await fetch(apiBase() + path, {
        method,
        headers,
        signal: controller.signal,
      })
      clearTimeout(timer)
      return await resp.json()
    } catch (err) {
      clearTimeout(timer)
      lastError = err
      if (attempt < MAX_RETRIES - 1) {
        const waitMs = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
        console.log(`[send] 第 ${attempt + 1} 次请求失败，${waitMs}ms 后重试: ${err.message}`)
        await delay(waitMs)
      }
    }
  }
  throw lastError
}

export { delay, startService, close_api, send, waitForApi }
