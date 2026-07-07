// Per-session bookkeeping for the completion gate: which files the agent wrote
// this session, the sync result for each, and any post-edit findings. Immutable
// — every mutation returns a new SessionState (the loop holds the latest).
export function emptySessionState() {
    return { writtenFiles: new Map(), gateIterations: 0 };
}
/** Record (or overwrite) the latest write for a path. Returns a new state. */
export function recordWrite(state, path, sync, findings) {
    const writtenFiles = new Map(state.writtenFiles);
    writtenFiles.set(path, { path, sync, findings });
    return { ...state, writtenFiles };
}
export function incrementGateIterations(state) {
    return { ...state, gateIterations: state.gateIterations + 1 };
}
