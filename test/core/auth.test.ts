import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  authStatus,
  clearApiKey,
  getAuthFilePath,
  hasApiKey,
  resolveApiKey,
  saveApiKey,
} from '../../src/core/auth.js'

describe('core/auth', () => {
  let xdgDir: string
  let savedXdg: string | undefined
  let savedAnthropic: string | undefined
  let savedClaude: string | undefined

  beforeEach(() => {
    xdgDir = mkdtempSync(join(tmpdir(), 'graphcode-auth-xdg-'))
    savedXdg = process.env.XDG_CONFIG_HOME
    savedAnthropic = process.env.ANTHROPIC_API_KEY
    savedClaude = process.env.CLAUDE_API_KEY
    process.env.XDG_CONFIG_HOME = xdgDir
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_API_KEY
  })

  afterEach(() => {
    rmSync(xdgDir, { recursive: true, force: true })
    if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg
    else delete process.env.XDG_CONFIG_HOME
    if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic
    else delete process.env.ANTHROPIC_API_KEY
    if (savedClaude !== undefined) process.env.CLAUDE_API_KEY = savedClaude
    else delete process.env.CLAUDE_API_KEY
  })

  it('resolves nothing when no env vars and no auth file exist', () => {
    expect(resolveApiKey()).toBeNull()
    expect(hasApiKey()).toBe(false)
    expect(authStatus()).toEqual({ configured: false })
  })

  it('saves a key to the auth file under XDG_CONFIG_HOME with 0600 permissions', () => {
    const result = saveApiKey('sk-ant-test1234567890')
    expect(result.warning).toBeUndefined()
    expect(result.path).toBe(join(xdgDir, 'graphcode', 'auth.json'))
    expect(existsSync(result.path)).toBe(true)

    const mode = statSync(result.path).mode & 0o777
    expect(mode).toBe(0o600)

    const contents = JSON.parse(readFileSync(result.path, 'utf8')) as { anthropic: { apiKey: string } }
    expect(contents.anthropic.apiKey).toBe('sk-ant-test1234567890')
  })

  it('warns (but still saves) when the key does not look like an Anthropic key', () => {
    const result = saveApiKey('not-a-real-key')
    expect(result.warning).toMatch(/sk-/)
    expect(resolveApiKey()).toEqual({ key: 'not-a-real-key', source: 'auth-file' })
  })

  it('resolves from the auth file when no env var is set', () => {
    saveApiKey('sk-ant-fromfile')
    expect(resolveApiKey()).toEqual({ key: 'sk-ant-fromfile', source: 'auth-file' })
    expect(hasApiKey()).toBe(true)
  })

  it('prefers ANTHROPIC_API_KEY over the auth file', () => {
    saveApiKey('sk-ant-fromfile')
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fromenv'
    expect(resolveApiKey()).toEqual({ key: 'sk-ant-fromenv', source: 'env' })
  })

  it('prefers CLAUDE_API_KEY over the auth file when ANTHROPIC_API_KEY is unset', () => {
    saveApiKey('sk-ant-fromfile')
    process.env.CLAUDE_API_KEY = 'sk-ant-fromclaudeenv'
    expect(resolveApiKey()).toEqual({ key: 'sk-ant-fromclaudeenv', source: 'env' })
  })

  it('prefers ANTHROPIC_API_KEY over CLAUDE_API_KEY when both env vars are set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-anthropic'
    process.env.CLAUDE_API_KEY = 'sk-ant-claude'
    expect(resolveApiKey()).toEqual({ key: 'sk-ant-anthropic', source: 'env' })
  })

  it('reports masked key and source via authStatus', () => {
    saveApiKey('sk-ant-abcdefghijklmnop')
    const status = authStatus()
    expect(status.configured).toBe(true)
    expect(status.source).toBe('auth-file')
    expect(status.masked).toMatch(/^sk-ant\.\.\.mnop$/)
  })

  it('clearApiKey removes the stored file and returns true, false when nothing to remove', () => {
    saveApiKey('sk-ant-toclear')
    expect(clearApiKey()).toBe(true)
    expect(existsSync(getAuthFilePath())).toBe(false)
    expect(clearApiKey()).toBe(false)
  })

  it('rejects an empty key', () => {
    expect(() => saveApiKey('   ')).toThrow()
  })

  it('respects the default ~/.config/graphcode path shape when XDG_CONFIG_HOME is unset', () => {
    delete process.env.XDG_CONFIG_HOME
    expect(getAuthFilePath().endsWith(join('.config', 'graphcode', 'auth.json'))).toBe(true)
  })
})
