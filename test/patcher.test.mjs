/**
 * Synthetic-archive tests for lib/patcher.mjs.
 *
 * These build a tiny but structurally valid asar in a temp directory, so the
 * patch/restore cycle is verified without touching an installed application.
 *
 * Run: node --test test/patcher.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, buildPatched, restore, status } from '../lib/patcher.mjs'

/** A minimal main.js carrying the stock tray template. */
const STOCK_MAIN = `import { app, Menu, Tray } from "electron";
var DesktopTray = class {
	relabel() {
		const { messages } = this.options.locale();
		tray.setContextMenu(Menu.buildFromTemplate([
			{
				label: messages.openApplication,
				click: () => {
					this.options.open();
				}
			},
			{ type: "separator" },
			{
				label: messages.quitApplication,
				click: () => {
					this.options.quit();
				}
			}
		]));
	}
};
export {};
`

/** Write a minimal asar with two packed entries. */
function writeArchive(directory, main, extra) {
  const mainBytes = Buffer.from(main, 'utf8')
  const extraBytes = Buffer.from(extra, 'utf8')
  const header = {
    files: {
      lib: {
        files: {
          'main.js': {
            size: mainBytes.length,
            offset: '0',
            integrity: {
              algorithm: 'SHA256',
              hash: createHash('sha256').update(mainBytes).digest('hex'),
              blockSize: 4194304,
              blocks: [createHash('sha256').update(mainBytes).digest('hex')],
            },
          },
        },
      },
      'README.txt': { size: extraBytes.length, offset: String(mainBytes.length) },
    },
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(json.length + 8, 4)
  prefix.writeUInt32LE(json.length + 4, 8)
  prefix.writeUInt32LE(json.length, 12)
  const path = join(directory, 'app.asar')
  writeFileSync(path, Buffer.concat([prefix, json, mainBytes, extraBytes]))
  return { path, mainBytes, extraBytes, jsonLength: json.length }
}

/** Read one entry the way Electron/asar does. */
function readEntry(archive, segmentPath) {
  const bytes = readFileSync(archive)
  const jsonSize = bytes.readUInt32LE(12)
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8'))
  let node = header
  for (const part of segmentPath.split('/')) node = node.files[part]
  const base = 16 + jsonSize + Number(node.offset)
  return {
    bytes: bytes.subarray(base, base + Number(node.size)),
    header: node,
    headerText: bytes.subarray(16, 16 + jsonSize).toString('utf8'),
  }
}

test('buildPatched keeps the byte length and is idempotent', () => {
  const original = Buffer.from(STOCK_MAIN, 'utf8')
  const first = buildPatched(original)
  assert.equal(first.state, 'stock')
  assert.equal(first.bytes.length, original.length)
  const text = first.bytes.toString('utf8')
  assert.match(text, /restartAppHostMenu/)
  assert.match(text, /app\.relaunch\(\);quitWithoutConfirmation\(\)/)
  assert.equal(buildPatched(first.bytes).state, 'patched')
})

test('apply patches, refreshes integrity, and leaves other entries intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tray-patch-'))
  process.env.DSH_TRAY_RESTART_HOME = join(directory, 'state')
  try {
    const extra = 'untouched payload\n'
    const { path, mainBytes, extraBytes } = writeArchive(directory, STOCK_MAIN, extra)
    assert.equal(status(path).status, 'stock')

    const result = apply({ asar: path })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'patched')

    const main = readEntry(path, 'lib/main.js')
    assert.equal(main.bytes.length, mainBytes.length)
    assert.match(main.bytes.toString('utf8'), /restartAppHostMenu/)

    const digest = createHash('sha256').update(main.bytes).digest('hex')
    assert.equal(main.header.integrity.hash, digest)
    assert.equal(main.header.integrity.blocks[0], digest)

    const other = readEntry(path, 'README.txt')
    assert.deepEqual(other.bytes, extraBytes)

    assert.equal(apply({ asar: path }).status, 'already')
  } finally {
    delete process.env.DSH_TRAY_RESTART_HOME
    rmSync(directory, { recursive: true, force: true })
  }
})

test('restore writes the original file and integrity digest back', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tray-restore-'))
  process.env.DSH_TRAY_RESTART_HOME = join(directory, 'state')
  try {
    const { path, mainBytes } = writeArchive(directory, STOCK_MAIN, 'x')
    const originalDigest = createHash('sha256').update(mainBytes).digest('hex')
    apply({ asar: path })
    assert.equal(status(path).status, 'patched')

    const result = restore({ asar: path })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'restored')
    assert.equal(status(path).status, 'stock')

    const main = readEntry(path, 'lib/main.js')
    assert.deepEqual(main.bytes, mainBytes)
    assert.equal(main.header.integrity.hash, originalDigest)
  } finally {
    delete process.env.DSH_TRAY_RESTART_HOME
    rmSync(directory, { recursive: true, force: true })
  }
})
