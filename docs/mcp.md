# MCP setup

GraphCode can serve its knowledge graph to any MCP-capable agent over stdio via `graphcode mcp`.
This lets Claude Code, Cursor, or any other MCP client query the same graph that GraphCode's own
built-in agent uses — you get graph-native retrieval without switching tools.

Running `graphcode mcp` does **not** require an `ANTHROPIC_API_KEY`; it only serves the graph.
The repo must already be indexed (or `graphcode mcp` will index it on startup, same as running
bare `graphcode`).

## Claude Code

Add GraphCode as an MCP server, scoped to the current project:

```bash
claude mcp add graphcode -- graphcode mcp
```

This registers `graphcode mcp` as a stdio MCP server. Claude Code will start it automatically
whenever it opens the project, and it will show up alongside your other tools. Verify with:

```bash
claude mcp list
```

To scope it to your user config instead of one project, add `--scope user`.

## Cursor

Add a `.cursor/mcp.json` (project-scoped) or edit your global Cursor MCP config:

```json
{
  "mcpServers": {
    "graphcode": {
      "command": "graphcode",
      "args": ["mcp"]
    }
  }
}
```

Restart Cursor (or reload the MCP servers panel) and `graphcode` tools should appear in the
available tools list.

## Any other MCP client

`graphcode mcp` speaks standard MCP over stdio, so any client that can spawn a subprocess and
speak MCP works the same way — point it at the `graphcode mcp` command with the working directory
set to your repo root.

## Tools exposed over MCP

The MCP server exposes the same query surface as the CLI's query commands — search, callers,
callees, impact analysis, neighbor exploration, and the ranked context-pack builder — as MCP
tools, backed by the already-indexed `.graphcode/graph.db`. See [docs/agent.md](agent.md) for the
full tools table (the same tools power both GraphCode's built-in agent and the MCP server; only
the transport differs).

## Multiple repos

If you're working across a [cross-repo workspace](workspaces.md), run `graphcode mcp` from the
root repo that declares `workspaceRepos` in its `graphcode.json` — queries will federate across
all member repos' databases, same as the CLI does.

## Troubleshooting

- **"No GraphCode index found"** — run `graphcode` (or `graphcode index`) once in the repo before
  starting the MCP server, or let `graphcode mcp` index on first launch.
- **Stale results** — GraphCode syncs incrementally on every `graphcode` invocation, but the MCP
  server process itself doesn't watch the filesystem while running; restart it (or re-run
  `graphcode index`) after large changes if your client keeps a long-lived MCP session open.
- **Client can't find the binary** — make sure `graphcode` is on `PATH` (see the Installation
  section of the [README](../README.md)), or use an absolute path to the binary in your client's
  MCP server config.
