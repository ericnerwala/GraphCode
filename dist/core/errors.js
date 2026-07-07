export class GraphcodeError extends Error {
    hint;
    constructor(message, hint) {
        super(message);
        this.hint = hint;
        this.name = 'GraphcodeError';
    }
}
export class NotIndexedError extends GraphcodeError {
    constructor(root) {
        super(`No GraphCode index found for ${root}`, 'Run `graphcode index` first (or just `graphcode` — it indexes on start).');
        this.name = 'NotIndexedError';
    }
}
