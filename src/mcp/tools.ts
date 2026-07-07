/**
 * Plain JSON Schema tool definitions for the GraphCode MCP server.
 * Deliberately avoids the SDK's zod-raw-shape `registerTool` helper: with
 * zod v4 its typing does not line up cleanly, so the low-level `Server`
 * class + hand-written JSON Schema is used instead (see server.ts).
 */

export type ToolName =
  | 'graph_search'
  | 'graph_explore'
  | 'graph_callers'
  | 'graph_callees'
  | 'graph_impact'
  | 'graph_context'

export interface ToolDefinition {
  readonly name: ToolName
  readonly description: string
  readonly inputSchema: {
    readonly type: 'object'
    readonly properties: Record<string, unknown>
    readonly required?: readonly string[]
  }
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'graph_search',
    description:
      'Full-text search over the whole knowledge graph (files, symbols, commits, docs, features). ' +
      'Prefer this as the first move when you have a name, keyword, or vague description and need ' +
      'to find where something lives before reading code. Faster and broader than graph_explore.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text (identifier, keyword, or phrase).' },
        limit: { type: 'number', description: 'Max results to return (default 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'graph_explore',
    description:
      'Expand the graph neighborhood (contains/calls/imports/references/etc.) around one or more ' +
      'known symbols or files. Use this once graph_search has given you exact names and you want to ' +
      'see what they connect to, before deciding what to read or change.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact symbol or file names/qualified names to explore.',
        },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'graph_callers',
    description:
      'Find everything that calls (or otherwise references) a given symbol, walking the call graph ' +
      'up to a depth. Use before modifying or removing a function/method to see who depends on it.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact symbol name or qualified name.' },
        depth: { type: 'number', description: 'Traversal depth (default 1).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'graph_callees',
    description:
      'Find everything a given symbol calls or depends on, walking the call graph up to a depth. ' +
      'Use to understand what a function does by seeing what it delegates to, without reading the ' +
      'whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Exact symbol name or qualified name.' },
        depth: { type: 'number', description: 'Traversal depth (default 1).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'graph_impact',
    description:
      'Blast-radius / impact analysis for a symbol or file: everything transitively affected across ' +
      'code, tests, git co-change history, and features. Use this before making a risky change to ' +
      'decide what else needs review or testing — it is the most expensive and most complete of the ' +
      'graph tools, so prefer graph_callers/graph_callees for a quick local check.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Symbol name, qualified name, or file path.' },
        depth: { type: 'number', description: 'Traversal depth (default 2).' },
        limit: { type: 'number', description: 'Max results to return (default 50).' },
      },
      required: ['target'],
    },
  },
  {
    name: 'graph_context',
    description:
      'Build a ranked, token-budgeted context pack (relevant files, symbols, commits, docs, features) ' +
      'for a natural-language task description. Use this at the start of a task instead of manually ' +
      'chaining search/explore calls when you want the single best starting bundle of context.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Natural-language description of the task at hand.' },
        budget: { type: 'number', description: 'Approximate token budget for the returned pack.' },
      },
      required: ['task'],
    },
  },
]
