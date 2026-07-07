// Public API barrel for GraphCode. Consumers embedding GraphCode as a
// library (rather than the CLI) import from here.
export { GraphStore, toFtsQuery } from './graph/store.js';
export { loadConfig, GRAPH_DIR_NAME, CONFIG_FILE_NAME } from './core/config.js';
export { GraphcodeError, NotIndexedError } from './core/errors.js';
export { estimateTokens, clampToTokens } from './core/tokens.js';
export { indexRepo } from './index/indexer.js';
export { scanRepo } from './index/scanner.js';
export { ingestGitHistory } from './git/history.js';
export { ingestDocs } from './knowledge/specs.js';
export { ingestFeatures } from './knowledge/features.js';
export { resolveSymbol, findCallers, findCallees, explore, impactAnalysis, buildContextPack, } from './query/index.js';
export { startAgentSession } from './agent/session.js';
export { openWorkspace, workspaceSearch, workspaceImpact, closeWorkspace } from './workspace/federation.js';
export { ensureIndexed } from './cli/commands/index-cmd.js';
