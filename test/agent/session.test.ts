import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgentSession } from '../../src/agent/session.js'
import type { AgentMessage, MessageParam, MessagesClient } from '../../src/agent/loop.js'
import { GraphcodeError } from '../../src/core/errors.js'
import { makeAgentFixture, type AgentFixture } from './fixtures.js'

function textMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

describe('startAgentSession - print mode', () => {
  let fixture: AgentFixture

  beforeEach(() => {
    fixture = makeAgentFixture()
  })

  afterEach(() => {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
  })

  it('prepends the turn-0 context pack to the first user message', async () => {
    let firstUserContent: unknown
    const client: MessagesClient = {
      create: async (params) => {
        if (firstUserContent === undefined) {
          firstUserContent = params.messages[0]?.content
        }
        return textMessage('ok')
      },
    }

    await startAgentSession(fixture.store, fixture.config, { prompt: 'explain helper' }, client)

    expect(typeof firstUserContent).toBe('string')
    expect(firstUserContent as string).toContain('Graph context')
    expect(firstUserContent as string).toContain('explain helper')
  })

  it('single-turn print mode exits after one end_turn response', async () => {
    let callCount = 0
    const client: MessagesClient = {
      create: async () => {
        callCount += 1
        return textMessage('done')
      },
    }
    await startAgentSession(fixture.store, fixture.config, { prompt: 'do something' }, client)
    expect(callCount).toBe(1)
  })

  it('respects an explicit maxTurns for a tool-calling loop', async () => {
    let callCount = 0
    const client: MessagesClient = {
      create: async () => {
        callCount += 1
        return {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${callCount}`, name: 'graph_search', input: { query: 'helper' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
    }
    await startAgentSession(fixture.store, fixture.config, { prompt: 'loop', maxTurns: 2 }, client)
    expect(callCount).toBe(2)
  })
})

describe('startAgentSession - missing API key', () => {
  let fixture: AgentFixture
  let savedApiKey: string | undefined
  let savedClaudeKey: string | undefined
  let savedXdg: string | undefined
  let xdgDir: string

  beforeEach(() => {
    fixture = makeAgentFixture()
    savedApiKey = process.env.ANTHROPIC_API_KEY
    savedClaudeKey = process.env.CLAUDE_API_KEY
    savedXdg = process.env.XDG_CONFIG_HOME
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_API_KEY
    // Hermetic: point the auth file lookup at an empty temp dir so a real
    // developer machine's ~/.config/graphcode/auth.json can't leak into this test.
    xdgDir = mkdtempSync(join(tmpdir(), 'graphcode-session-xdg-'))
    process.env.XDG_CONFIG_HOME = xdgDir
  })

  afterEach(() => {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
    rmSync(xdgDir, { recursive: true, force: true })
    if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey
    if (savedClaudeKey !== undefined) process.env.CLAUDE_API_KEY = savedClaudeKey
    if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg
    else delete process.env.XDG_CONFIG_HOME
  })

  it('throws a friendly GraphcodeError when no client is injected, no key is set, and stdin is not a TTY', async () => {
    expect(process.stdin.isTTY).toBeFalsy()
    await expect(startAgentSession(fixture.store, fixture.config, { prompt: 'hi' })).rejects.toThrow(
      'No Anthropic API key configured',
    )
  })

  it('mentions both `graphcode auth login` and ANTHROPIC_API_KEY in the error hint', async () => {
    try {
      await startAgentSession(fixture.store, fixture.config, { prompt: 'hi' })
      expect.unreachable('expected startAgentSession to throw')
    } catch (error) {
      const hint = (error as GraphcodeError).hint
      expect(hint).toContain('graphcode auth login')
      expect(hint).toContain('ANTHROPIC_API_KEY')
    }
  })
})
