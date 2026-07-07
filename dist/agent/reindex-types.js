// The shared contract produced by live graph sync (graph-sync.ts) and consumed
// by post-edit verification and the completion gate. Extracted into its own
// module so those consumers depend only on the shape, not on graph-sync.ts's
// implementation (which pulls in the indexer internals).
export {};
