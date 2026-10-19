/**
 * dsh-tray-restart patcher — add a "Restart" item to the official DeepSeek
 * Harness desktop system-tray menu by editing the Electron main-process file
 * inside `resources/app.asar`.
 *
 * Why an asar edit: the tray belongs to the Electron main process, while DSH
 * plugins run in the Host child process. Cordis exposes no tray or Electron
 * main-process service, so there is no supported extension point for a tray
 * menu item. This module performs a *byte-length-preserving* rewrite of
 * `/lib/main.js`: the tray template is compacted so that the restart item fits
 * inside the original size, and the file is padded with trailing whitespace.
 * Every other file offset in the archive therefore stays valid.
 *
 * The asar entry integrity digest is refreshed too, so the archive remains
 * internally consistent even if `EnableEmbeddedAsarIntegrityValidation` is on.
 *
 * The Electron main process patches `node:fs` to read `app.asar` as a virtual
 * directory, which is why this module must run in a plain Node process (the
 * plugin spawns it with ELECTRON_RUN_AS_NODE=1 and ELECTRON_NO_ASAR=1).
 *
 * @module dsh-tray-restart/lib/patcher
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The tray template written by 1.0.x (restart only), upgraded in place. */
const V1_CALL =
  'tray.setContextMenu(Menu.buildFromTemplate([{label:messages.openApplication,' +
  'click:this.options.open},{label:messages.restartAppHostMenu,' +
  'click:()=>{app.relaunch();quitWithoutConfirmation()}},{type:"separator"},' +
  '{label:messages.quitApplication,click:this.options.quit}]));'

/** The compact tray template written by this patcher. */
const PATCHED_CALL =
  'tray.setContextMenu(Menu.buildFromTemplate([{label:messages.openApplication,' +
  'click:this.options.open},{label:messages.restartAppHostMenu,' +
  'click:()=>{app.relaunch();quitWithoutConfirmation()}},' +
  '{label:messages.reloadPageMenu,' +
  'click:()=>{const w=BrowserWindow.getAllWindows()[0];if(w&&!w.isDestroyed())w.webContents.reload()}},' +
  '{type:"separator"},{label:messages.quitApplication,click:this.options.quit}]));'

/** Matches the stock tray template (open / separator / quit, nothing else). */
const STOCK_CALL = /tray\.setContextMenu\(Menu\.buildFromTemplate\(\[[\s\S]{0,2000}?\]\)\);/

/** Trailing whitespace this patcher appends to keep the byte length. */
const TRAILING_PAD = /[ ]+$/

/**
 * Documentation comments shortened when the two menu items need more bytes.
 * Each pair must occur at most once in the stock main.js.
 */
const COMMENT_TRIMS = [
  [
    '/** Rebuild the tooltip and context menu in the current locale. */',
    '/** Tray menu. */',
  ],
  [
    '/** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */',
    '/** Windows tray. */',
  ],
]

/** Default install location relative to `%LOCALAPPDATA%`. */
const DEFAULT_ASAR_SEGMENTS = ['Programs', 'DeepSeek Harness', 'resources', 'app.asar']

/** Where the unpatched `/lib/main.js` is kept for `restore`. */
export function stateDirectory() {
  return join(process.env.DSH_TRAY_RESTART_HOME ?? join(homedir(), '.dsh', 'dsh-tray-restart'))
}

/**
 * Locate `app.asar`.
 * @param explicit - caller-supplied path.
 * @returns the first existing candidate, or undefined.
 */
export function resolveAsar(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0 && existsSync(explicit)) return explicit
  const fromEnv = process.env.DSH_DESKTOP_APP_ASAR
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && existsSync(fromEnv)) return fromEnv
  const local = process.env.LOCALAPPDATA
  if (typeof local === 'string' && local.length > 0) {
    const candidate = join(local, ...DEFAULT_ASAR_SEGMENTS)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Read and validate the asar directory.
 * @param fd - open archive handle.
 * @returns directory geometry for `/lib/main.js`.
 */
function readDirectory(fd) {
  const prefix = Buffer.alloc(16)
  readSync(fd, prefix, 0, 16, 0)
  const hashSize = prefix.readUInt32LE(0)
  const directorySize = prefix.readUInt32LE(4)
  const jsonSize = prefix.readUInt32LE(12)
  if (hashSize !== 4) throw new Error(`unexpected asar hash header (${hashSize})`)
  if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) throw new Error(`unexpected asar directory size (${jsonSize})`)
  if (directorySize < jsonSize) throw new Error('unexpected asar directory layout')
  const headerBytes = Buffer.alloc(jsonSize)
  readSync(fd, headerBytes, 0, jsonSize, 16)
  const headerText = headerBytes.toString('utf8')
  const header = JSON.parse(headerText)
  const entry = header?.files?.lib?.files?.['main.js']
  if (entry === undefined || entry.offset === undefined || entry.size === undefined) {
    throw new Error('lib/main.js is not packed in this archive')
  }
  if (entry.unpacked === true) throw new Error('lib/main.js is unpacked; this build is not supported')
  return {
    jsonSize,
    header,
    headerText,
    dataBase: 16 + jsonSize,
    entryOffset: Number(entry.offset),
    entrySize: Number(entry.size),
  }
}

/**
 * Build the patched `/lib/main.js` bytes without changing their length.
 * Handles the stock file and the 1.0.x restart-only patch.
 * @param original - the current file bytes.
 * @returns `{ state: 'stock'|'patched', bytes, note }`.
 */
export function buildPatched(original) {
  let text = original.toString('utf8')
  if (text.includes('messages.reloadPageMenu,click:')) {
    return { state: 'patched', bytes: original, note: 'already patched' }
  }

  // Drop the padding a previous run appended before rebuilding.
  text = text.replace(TRAILING_PAD, '')

  let next
  if (text.includes(V1_CALL)) {
    next = text.replace(V1_CALL, PATCHED_CALL)
  } else {
    const matches = text.match(new RegExp(STOCK_CALL.source, 'g')) ?? []
    if (matches.length !== 1) {
      throw new Error(`expected exactly one stock tray template, found ${matches.length}`)
    }
    const stock = matches[0]
    if (!stock.includes('messages.openApplication') || !stock.includes('messages.quitApplication')) {
      throw new Error('tray template does not look like the known open/quit menu')
    }
    if ((stock.match(/label:/g) ?? []).length !== 2) {
      throw new Error('tray template already has extra items; refusing to rewrite it')
    }
    next = text.replace(STOCK_CALL, PATCHED_CALL)
  }

  // Compact documentation comments only when the two items need the space.
  let over = Buffer.byteLength(next, 'utf8') - original.length
  for (const [from, to] of COMMENT_TRIMS) {
    if (over <= 0) break
    if (!next.includes(from)) continue
    next = next.replace(from, to)
    over = Buffer.byteLength(next, 'utf8') - original.length
  }
  if (over > 0) {
    throw new Error(`patch would grow main.js by ${over} bytes even after compaction`)
  }

  next += ' '.repeat(-over)
  const bytes = Buffer.from(next, 'utf8')
  if (bytes.length !== original.length) throw new Error('length check failed')
  return { state: 'stock', bytes, note: 'patch ready' }
}

/**
 * Inspect the archive.
 * @param asar - archive path.
 * @returns status describing the tray patch.
 */
export function status(asar) {
  const target = asar ?? resolveAsar()
  if (target === undefined) return { ok: false, status: 'missing', message: 'app.asar not found' }
  const fd = openSync(target, 'r')
  try {
    const dir = readDirectory(fd)
    const current = Buffer.alloc(dir.entrySize)
    readSync(fd, current, 0, dir.entrySize, dir.dataBase + dir.entryOffset)
    const text = current.toString('utf8')
    const hasRestart = text.includes('messages.restartAppHostMenu,click:')
    const hasReload = text.includes('messages.reloadPageMenu,click:')
    return {
      ok: true,
      status: hasReload && hasRestart ? 'patched' : hasRestart ? 'outdated' : 'stock',
      asar: target,
      mainBytes: dir.entrySize,
      headerBytes: dir.jsonSize,
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Rewrite the `/lib/main.js` integrity digest in the asar directory.
 * The SHA-256 hex string has a fixed length, so the directory stays the same size.
 * @param fd - open archive handle.
 * @param dir - directory geometry from {@link readDirectory}.
 * @param digest - new lowercase hex digest.
 */
function updateIntegrity(fd, dir, digest) {
  const previous = dir.header.files.lib.files['main.js'].integrity
  if (previous?.hash === undefined || previous.hash === digest) return
  const oldHash = String(previous.hash)
  if (!/^[0-9a-f]{64}$/iu.test(oldHash)) throw new Error('unexpected asar integrity hash')
  const replaced = dir.headerText.replaceAll(`"${oldHash}"`, `"${digest}"`)
  if (replaced.length !== dir.headerText.length) throw new Error('integrity header rewrite changed its size')
  if (JSON.parse(replaced).files.lib.files['main.js'].integrity.hash !== digest) {
    throw new Error('integrity header rewrite did not take effect')
  }
  writeSync(fd, Buffer.from(replaced, 'utf8'), 0, dir.jsonSize, 16)
}

/**
 * Apply the patch when needed. Safe to call repeatedly.
 * @param options - `{ asar, dryRun }`.
 * @returns result object; never throws for the expected unsupported layouts.
 */
export function apply(options = {}) {
  const target = options.asar ?? resolveAsar()
  if (target === undefined) return { ok: false, status: 'missing', message: 'app.asar not found' }
  const fd = openSync(target, 'r+')
  try {
    const dir = readDirectory(fd)
    const current = Buffer.alloc(dir.entrySize)
    readSync(fd, current, 0, dir.entrySize, dir.dataBase + dir.entryOffset)

    let built
    try {
      built = buildPatched(current)
    } catch (error) {
      return { ok: false, status: 'unsupported', asar: target, message: error.message }
    }
    if (built.state === 'patched') {
      return { ok: true, status: 'already', asar: target, mainBytes: dir.entrySize }
    }
    if (options.dryRun === true) {
      return { ok: true, status: 'dry-run', asar: target, mainBytes: dir.entrySize }
    }

    saveOriginal(current, dir.entrySize)

    // 1. Rewrite the file body (same size).
    writeSync(fd, built.bytes, 0, built.bytes.length, dir.dataBase + dir.entryOffset)

    // 2. Refresh the entry integrity digest in the directory, preserving its
    //    exact byte length (SHA-256 hex is always 64 characters).
    const digest = createHash('sha256').update(built.bytes).digest('hex')
    updateIntegrity(fd, dir, digest)

    // 3. Verify the archive still parses and the entry reads back as patched.
    const after = status(target)
    if (after.status !== 'patched') throw new Error('verification failed after writing')

    return {
      ok: true,
      status: 'patched',
      asar: target,
      mainBytes: dir.entrySize,
      digest,
      message: 'restart the desktop app to see the new tray item',
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Restore the unpatched `/lib/main.js` saved before the first patch.
 * @param options - `{ asar }`.
 */
export function restore(options = {}) {
  const target = options.asar ?? resolveAsar()
  if (target === undefined) return { ok: false, status: 'missing', message: 'app.asar not found' }
  const saved = loadOriginal()
  if (saved === undefined) {
    return { ok: false, status: 'no-backup', asar: target, message: 'no saved original; reinstall the app instead' }
  }
  const fd = openSync(target, 'r+')
  try {
    const dir = readDirectory(fd)
    if (dir.entrySize !== saved.bytes.length) {
      return {
        ok: false,
        status: 'size-mismatch',
        asar: target,
        message: `saved original is ${saved.bytes.length} bytes but this app has ${dir.entrySize}; reinstall the app`,
      }
    }
    writeSync(fd, saved.bytes, 0, saved.bytes.length, dir.dataBase + dir.entryOffset)
    updateIntegrity(fd, dir, createHash('sha256').update(saved.bytes).digest('hex'))
    const after = status(target)
    return { ok: true, status: after.status === 'stock' ? 'restored' : 'unknown', asar: target }
  } finally {
    closeSync(fd)
  }
}

/** Persist the pre-patch main.js for restore. */
function saveOriginal(bytes, size) {
  const directory = stateDirectory()
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'main.original.js')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const metaPath = join(directory, 'main.original.json')
  if (existsSync(path) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (meta.size === size && meta.sha256 === digest) return
    } catch {
      /* rewrite below */
    }
  }
  const temp = `${path}.tmp`
  writeFileSync(temp, bytes)
  renameSync(temp, path)
  writeFileSync(metaPath, `${JSON.stringify({ size, sha256: digest }, null, 2)}\n`)
}

/** Load the saved pre-patch main.js, validating its size and digest. */
function loadOriginal() {
  const directory = stateDirectory()
  const path = join(directory, 'main.original.js')
  const metaPath = join(directory, 'main.original.json')
  if (!existsSync(path) || !existsSync(metaPath)) return undefined
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const bytes = readFileSync(path)
  if (bytes.length !== meta.size) return undefined
  if (createHash('sha256').update(bytes).digest('hex') !== meta.sha256) return undefined
  return { bytes, meta }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const [command = 'status', ...rest] = process.argv.slice(2)
  const asarFlag = rest.indexOf('--asar')
  const asar = asarFlag >= 0 ? rest[asarFlag + 1] : undefined
  const json = rest.includes('--json')
  let result
  try {
    if (command === 'apply') result = apply({ asar, dryRun: rest.includes('--dry-run') })
    else if (command === 'restore') result = restore({ asar })
    else if (command === 'status') result = status(asar)
    else throw new Error(`unknown command: ${command}`)
  } catch (error) {
    result = { ok: false, status: 'error', message: error?.message ?? String(error) }
  }
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok === true ? 0 : 1
}
