// Tool definitions for the Anthropic Messages API: name, description, and a JSON
// Schema input_schema. Kept separate from dispatch logic so the schema list can be
// passed straight into `messages.create({ tools })`.
export const TOOL_DEFS = [
    {
        name: 'graph_search',
        description: 'Full-text search over the code knowledge graph. Returns matching symbols (file, line, kind) ranked by relevance. Use to locate exact symbol names before graph_explore/graph_callers/graph_callees/graph_impact.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search terms (symbol name or text).' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'graph_explore',
        description: "PRIMARY graph tool for flow/trace questions. Given a bag of symbol names (functions, methods, classes), connects and returns the call flow among them. Use FIRST for any 'how does X reach Y' / trace / data-flow question. Treat the returned source as already read.",
        input_schema: {
            type: 'object',
            properties: {
                symbols: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Symbol names spanning the flow (qualified Class.method names disambiguate overloads).',
                },
            },
            required: ['symbols'],
            additionalProperties: false,
        },
    },
    {
        name: 'graph_callers',
        description: 'List every symbol that CALLS the given symbol (its incoming call sites), from the call graph.',
        input_schema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Symbol name (qualified Class.method to disambiguate).' },
                depth: { type: 'number', description: 'Traversal depth (default 1).' },
            },
            required: ['symbol'],
            additionalProperties: false,
        },
    },
    {
        name: 'graph_callees',
        description: 'List every symbol the given symbol CALLS (its outgoing calls), from the call graph.',
        input_schema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Symbol name (qualified Class.method to disambiguate).' },
                depth: { type: 'number', description: 'Traversal depth (default 1).' },
            },
            required: ['symbol'],
            additionalProperties: false,
        },
    },
    {
        name: 'graph_impact',
        description: 'Compute the impact radius (blast radius) of a symbol - the transitive set of code affected if it changes. Use BEFORE editing a symbol to scope the change.',
        input_schema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'Symbol name to compute impact for.' },
                depth: { type: 'number', description: 'Traversal depth (default 2).' },
            },
            required: ['target'],
            additionalProperties: false,
        },
    },
    {
        name: 'graph_context',
        description: 'Build a ranked context pack for a task description: the most relevant files/symbols in the repo for this task, straight from the graph. Use when starting work on a broad task and the turn-0 pack is insufficient or stale.',
        input_schema: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'Description of the task to build context for.' },
            },
            required: ['task'],
            additionalProperties: false,
        },
    },
    {
        name: 'read_file',
        description: 'Read a file from the repository. Prefer graph tools for symbols the graph already knows.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Repo-root-relative file path.' },
                offset: { type: 'number', description: '1-based starting line (optional).' },
                limit: { type: 'number', description: 'Max lines to return (optional).' },
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'write_file',
        description: 'Write (create or overwrite) a file in the repository.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Repo-root-relative file path.' },
                content: { type: 'string', description: 'Full file content to write.' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
    },
    {
        name: 'edit_file',
        description: 'Edit a file via exact string replacement. old_string must match exactly one location unless replace_all is set.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Repo-root-relative file path.' },
                old_string: { type: 'string', description: 'Exact text to replace.' },
                new_string: { type: 'string', description: 'Replacement text.' },
                replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
            },
            required: ['path', 'old_string', 'new_string'],
            additionalProperties: false,
        },
    },
    {
        name: 'list_dir',
        description: 'List the immediate entries of a directory in the repository.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Repo-root-relative directory path.' },
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'bash',
        description: 'Run a shell command in the repository root. Use to run tests/builds and verify edits. 120s default timeout; output is clamped.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute.' },
                timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 120000).' },
            },
            required: ['command'],
            additionalProperties: false,
        },
    },
];
