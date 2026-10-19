/**
 * dsh-tray-restart — add "Restart" and "Reload Page" items to the DeepSeek Harness desktop tray menu.
 *
 * The official desktop shell (Electron main process) owns the Windows system
 * tray. DSH plugins run in the Host child process behind Cordis and have no
 * Electron/tray service, so the only way to extend that menu is to patch the
 * shell's `resources/app.asar`. This plugin performs that patch at every Host
 * start, which also re-applies it after each desktop-app update.
 *
 * The actual rewrite runs in a separate plain-Node process because Electron
 * patches `node:fs` to treat `app.asar` as a virtual directory; the helper is
 * spawned with `ELECTRON_RUN_AS_NODE=1` and `ELECTRON_NO_ASAR=1` so it can open
 * the archive as ordinary bytes.
 *
 * @module dsh-tray-restart
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name. */
export const name = 'tray-restart'

/** This package's directory, resolved from the loaded ESM module. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/** The standalone patcher executed by the helper process. */
const PATCHER = join(PACKAGE_ROOT, 'lib', 'patcher.mjs')

/** Where the original main.js and the last run's status live. */
const STATE_DIR = join(process.env.DSH_TRAY_RESTART_HOME ?? join(homedir(), '.dsh', 'dsh-tray-restart'))

/** How long to wait after activation before touching the archive. */
const DEFAULT_DELAY_MS = 2000

/**
 * Log a line through the Host logger when available, otherwise the console.
 * @param ctx - this plugin's Cordis context.
 * @param level - `info` or `warn`.
 * @param message - text to record.
 */
function log(ctx, level, message) {
  const line = `dsh-tray-restart: ${message}`
  try {
    if (typeof ctx?.logger?.[level] === 'function') {
      ctx.logger[level](line)
      return
    }
  } catch {
    /* fall through to the console */
  }
  try {
    if (level === 'warn') console.warn(line)
    else console.info(line)
  } catch {
    /* logging is best-effort */
  }
}

/**
 * Persist the last run so users can inspect it without a log sink.
 * @param payload - status to record.
 */
function writeStatus(payload) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(join(STATE_DIR, 'status.json'), `${JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2)}\n`)
  } catch {
    /* status reporting must never break activation */
  }
}

/**
 * Run the patcher in an asar-free Node process.
 * @param command - `status`, `apply`, or `restore`.
 * @param asar - optional explicit archive path.
 * @returns the parsed JSON result, or an error result.
 */
function runPatcher(command, asar) {
  return new Promise((resolve) => {
    const args = [PATCHER, command, '--json']
    if (typeof asar === 'string' && asar.length > 0) args.push('--asar', asar)
    let child
    try {
      child = spawn(process.execPath, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, status: 'spawn-failed', message: error?.message ?? String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, status: 'timeout', message: `patcher timed out after 30s` })
    }, 30_000)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, status: 'spawn-failed', message: error?.message ?? String(error) })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
      if (line === undefined) {
        resolve({ ok: false, status: 'no-output', code, message: stderr.trim() || `patcher exited with ${String(code)}` })
        return
      }
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, status: 'bad-output', code, message: line })
      }
    })
  })
}

/**
 * Patch the desktop shell once per Host start. Safe and idempotent: a re-run
 * against an already patched archive is a read-only status check.
 * @param ctx - this plugin's Cordis context.
 */
export function apply(ctx) {
  if (process.platform !== 'win32') {
    log(ctx, 'info', 'skipped: the system tray item is Windows-only')
    return
  }
  const asar = process.env.DSH_DESKTOP_APP_ASAR
  ctx.effect(() => {
    const configured = Number.parseInt(process.env.DSH_TRAY_RESTART_DELAY_MS ?? '', 10)
    const delay = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_DELAY_MS
    let disposed = false
    const timer = setTimeout(() => {
      if (disposed) return
      runPatcher('apply', asar).then((result) => {
        if (disposed) return
        const message = result.ok === true
          ? `patch ${result.status}: ${result.asar ?? 'unknown archive'}`
          : `patch ${result.status}: ${result.message ?? 'unknown error'}`
        log(ctx, result.ok === true ? 'info' : 'warn', message)
        writeStatus({ result })
      })
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, 'dsh-tray-restart: keep the desktop tray Restart item patched')
}
