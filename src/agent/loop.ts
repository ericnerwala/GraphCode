// The agent loop: dispatches tool_use blocks through agent-tools, feeds tool_result
// back, and loops until end_turn or maxTurns. Supports both a streaming client
// (client.messages.stream) and a plain non-streaming create() via feature detection,
// so tests can inject a minimal fake without implementing the full SDK surface.

import { printRaw, printStatus } from '../core/output.js'
import { dispatchTool, TOOL_DEFS, type DispatchContext } from './agent-tools.js'

export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/** Other block kinds (thinking, server tool use, …) pass through untouched —
 * we only need to recognize text and tool_use to drive the loop. */
export interface OtherBlock {
  readonly type: string
  readonly [key: string]: unknown
}

export type ContentBlock = TextBlock | ToolUseBlock | OtherBlock

export interface Usage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number | null
  readonly cache_creation_input_tokens?: number | null
}

export interface AgentMessage {
  readonly role: 'assistant'
  readonly content: readonly ContentBlock[]
  readonly stop_reason: string | null
  readonly usage: Usage
}

export type MessageParamContent = string | readonly ContentBlockParam[]

export interface ContentBlockParam {
  readonly type: string
  readonly [key: string]: unknown
}

export interface MessageParam {
  readonly role: 'user' | 'assistant'
  readonly content: MessageParamContent
}

export interface ToolResultBlockParam extends ContentBlockParam {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string
  readonly is_error?: boolean
}

export interface SystemBlockParam {
  readonly type: 'text'
  readonly text: string
  readonly cache_control?: { readonly type: 'ephemeral' }
}

export interface MessageCreateParams {
  readonly model: string
  readonly max_tokens: number
  readonly system: readonly SystemBlockParam[]
  readonly messages: readonly MessageParam[]
  readonly tools: readonly { readonly name: string; readonly description: string; readonly input_schema: Record<string, unknown> }[]
}

/** Minimal async-iterable stream shape: text deltas plus a way to await the
 * complete message. Satisfied structurally by the real SDK's MessageStream. */
export interface MessageStreamLike {
  finalMessage(): Promise<AgentMessage>
  [Symbol.asyncIterator]?: () => AsyncIterator<StreamEventLike>
}

export interface StreamEventLike {
  readonly type: string
  readonly delta?: { readonly type: string; readonly text?: string }
  readonly [key: string]: unknown
}

/** The minimal Anthropic Messages API surface the loop depends on. The real SDK
 * client (`anthropic.messages`) satisfies this; tests inject a fake. Streaming is
 * feature-detected: if `.stream` exists it is preferred, else `.create` is used. */
export interface MessagesClient {
  create(params: MessageCreateParams): Promise<AgentMessage>
  stream?(params: MessageCreateParams): MessageStreamLike
}

export interface RunLoopOptions {
  readonly maxTurns?: number
}

const DEFAULT_MAX_TURNS = 40
const DEFAULT_MAX_TOKENS = 8192

/** Run the agent loop for one user turn (which may itself span many tool-use
 * round trips) until the model reaches end_turn or maxTurns is exhausted. */
export async function runAgentLoop(
  client: MessagesClient,
  model: string,
  systemPrompt: string,
  history: MessageParam[],
  dispatchCtx: DispatchContext,
  options: RunLoopOptions = {},
): Promise<MessageParam[]> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const system: SystemBlockParam[] = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }]
  const messages = [...history]

  let totalInputTokens = 0
  let totalOutputTokens = 0

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const params: MessageCreateParams = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system,
      messages,
      tools: TOOL_DEFS,
    }

    const response = await requestMessage(client, params)
    totalInputTokens += response.usage.input_tokens
    totalOutputTokens += response.usage.output_tokens

    messages.push({ role: 'assistant', content: response.content as unknown as ContentBlockParam[] })

    if (response.stop_reason !== 'tool_use') {
      printStatus(`[tokens] input=${totalInputTokens} output=${totalOutputTokens}`)
      return messages
    }

    const toolUses = response.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    const results: ToolResultBlockParam[] = toolUses.map((toolUse) => ({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: safeDispatch(toolUse, dispatchCtx),
    }))
    messages.push({ role: 'user', content: results })
  }

  printStatus(`[tokens] input=${totalInputTokens} output=${totalOutputTokens} (maxTurns=${maxTurns} reached)`)
  return messages
}

function safeDispatch(toolUse: ToolUseBlock, ctx: DispatchContext): string {
  try {
    return dispatchTool(toolUse.name, toolUse.input, ctx)
  } catch (error) {
    return `error: tool "${toolUse.name}" failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Prefer streaming when the client supports it (prints text deltas live);
 * fall back to plain create() for injected non-streaming test doubles. */
async function requestMessage(client: MessagesClient, params: MessageCreateParams): Promise<AgentMessage> {
  if (typeof client.stream === 'function') {
    const stream = client.stream(params)
    const makeIterator = stream[Symbol.asyncIterator]
    if (typeof makeIterator === 'function') {
      const iterator = makeIterator.call(stream)
      for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
        const event = step.value
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          printRaw(event.delta.text)
        }
      }
      printRaw('\n')
    }
    return stream.finalMessage()
  }
  return client.create(params)
}
