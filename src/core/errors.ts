export class GraphcodeError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'GraphcodeError'
  }
}

export class NotIndexedError extends GraphcodeError {
  constructor(root: string) {
    super(`No GraphCode index found for ${root}`, 'Run `graphcode index` first (or just `graphcode` — it indexes on start).')
    this.name = 'NotIndexedError'
  }
}
