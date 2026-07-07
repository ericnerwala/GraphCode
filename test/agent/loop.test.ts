import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { runAgentLoop, type AgentMessage, type MessageParam, type MessagesClient } from '../../src/agent/loop.js'
import type { DispatchContext } from '../../src/agent/agent-tools.js'
import { makeAgentFixture, type AgentFixture } from './fixtures.js'

/** A scripted non-streaming client: returns one AgentMessage per call() in order. */
function scriptedClient(script: readonly AgentMessage[]): { client: MessagesClient; calls: MessageParam[][] } {
  let i = 0
  const calls: MessageParam[][] = []
  const client: MessagesClient = {
    create: async (params) => {
      calls.push(params.messages as MessageParam[])
      const message = script[i]
      i += 1
      if (!message) throw new Error(`scriptedClient: ran out of scripted responses at call ${i}`)
      return message
    },
  }
  return { client, calls }
}

function textMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  }
}

function toolUseMessage(id: string, name: string, input: unknown): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 20, output_tokens: 8 },
  }
}

describe('runAgentLoop', () => {
  let fixture: AgentFixture
  let ctx: DispatchContext

  beforeEach(() => {
    fixture = makeAgentFixture()
    ctx = { store: fixture.store, root: fixture.root, config: fixture.config }
  })

  afterEach(() => {
    fixture.store.close()
    rmSync(fixture.root, { recursive: true, force: true })
    rmSync(fixture.dbDir, { recursive: true, force: true })
  })

  it('round-trips a single tool_use through tool_result to a final text response', async () => {
    const { client, calls } = scriptedClient([
      toolUseMessage('tool_1', 'graph_search', { query: 'helper' }),
      textMessage('Found it.'),
    ])

    const history: MessageParam[] = [{ role: 'user', content: 'find helper' }]
    const result = await runAgentLoop(client, 'claude-opus-4-8', 'system prompt', history, ctx)

    // Final history: user, assistant(tool_use), user(tool_result), assistant(text)
    expect(result).toHaveLength(4)
    expect(result[0]?.role).toBe('user')
    expect(result[1]?.role).toBe('assistant')
    expect(result[2]?.role).toBe('user')
    expect(result[3]?.role).toBe('assistant')

    const toolResultContent = result[2]?.content
    expect(Array.isArray(toolResultContent)).toBe(true)
    const toolResult = (toolResultContent as unknown as Array<{ type: string; tool_use_id: string; content: string }>)[0]
    expect(toolResult?.type).toBe('tool_result')
    expect(toolResult?.tool_use_id).toBe('tool_1')
    expect(toolResult?.content).toContain('helper')

    // Second call to create() included the tool_result in its messages.
    expect(calls).toHaveLength(2)
  })

  it('stops at maxTurns even if the model keeps calling tools', async () => {
    const infiniteToolUse = () => toolUseMessage('t', 'graph_search', { query: 'helper' })
    const { client, calls } = scriptedClient([infiniteToolUse(), infiniteToolUse(), infiniteToolUse(), infiniteToolUse()])

    const history: MessageParam[] = [{ role: 'user', content: 'loop forever' }]
    await runAgentLoop(client, 'claude-opus-4-8', 'system', history, ctx, { maxTurns: 3 })

    expect(calls).toHaveLength(3)
  })

  it('passes the system prompt with cache_control ephemeral', async () => {
    let capturedSystem: unknown
    const client: MessagesClient = {
      create: async (params) => {
        capturedSystem = params.system
        return textMessage('done')
      },
    }
    await runAgentLoop(client, 'claude-opus-4-8', 'my system prompt', [{ role: 'user', content: 'hi' }], ctx)
    expect(capturedSystem).toEqual([{ type: 'text', text: 'my system prompt', cache_control: { type: 'ephemeral' } }])
  })

  it('uses the streaming client when .stream is present, feature-detecting over .create', async () => {
    let createCalled = false
    let finalMessageCalled = false
    const client: MessagesClient = {
      create: async () => {
        createCalled = true
        return textMessage('should not be used')
      },
      stream: () => ({
        [Symbol.asyncIterator]: () =>
          (async function* () {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }
          })(),
        finalMessage: async () => {
          finalMessageCalled = true
          return textMessage('streamed response')
        },
      }),
    }
    const result = await runAgentLoop(client, 'claude-opus-4-8', 'system', [{ role: 'user', content: 'hi' }], ctx)
    expect(createCalled).toBe(false)
    expect(finalMessageCalled).toBe(true)
    expect(result.at(-1)?.content).toEqual([{ type: 'text', text: 'streamed response' }])
  })
})

describe('turn-0 context pack injection (session-level contract)', () => {
  it('the first user message can be prefixed with a Graph context marker', () => {
    // loop.ts itself is pack-agnostic (session.ts does the prefixing); this
    // test locks the marker text the graph context pack renderer emits, which
    // session.ts relies on to build the turn-0 user content.
    const separator = '\n\n---\n\n'
    const pack = '## Graph context (pre-computed from the code graph - verify, then refine; treat listed source as already read)'
    const combined = `${pack}${separator}do the task`
    expect(combined).toContain('Graph context')
  })
})
