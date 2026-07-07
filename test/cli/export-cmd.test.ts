import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { GraphcodeError } from '../../src/core/errors.js'
import { toVizServerError } from '../../src/cli/commands/export-cmd.js'

describe('toVizServerError', () => {
  it('maps EADDRINUSE to a friendly GraphcodeError with a --port hint', () => {
    const err = Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })
    const mapped = toVizServerError(err, 5173)
    expect(mapped).toBeInstanceOf(GraphcodeError)
    expect(mapped.message).toContain('port 5173 is already in use')
    expect((mapped as GraphcodeError).hint).toContain('--port')
  })

  it('passes through other server errors unchanged', () => {
    const err = Object.assign(new Error('some other failure'), { code: 'EACCES' })
    const mapped = toVizServerError(err, 5173)
    expect(mapped).toBe(err)
  })
})

describe('viz server EADDRINUSE (end-to-end)', () => {
  it('a second server bound to the same port fails with EADDRINUSE, which maps to a friendly error', async () => {
    const first = createServer(() => {})
    await new Promise<void>((resolvePromise) => first.listen(0, resolvePromise))
    const address = first.address()
    const port = typeof address === 'object' && address ? address.port : 0

    try {
      const second = createServer(() => {})
      const err = await new Promise<NodeJS.ErrnoException>((resolvePromise) => {
        second.once('error', (e: NodeJS.ErrnoException) => resolvePromise(e))
        second.listen(port)
      })
      expect(err.code).toBe('EADDRINUSE')
      const mapped = toVizServerError(err, port)
      expect(mapped).toBeInstanceOf(GraphcodeError)
      expect(mapped.message).toContain(`port ${port} is already in use`)
    } finally {
      await new Promise<void>((resolvePromise) => first.close(() => resolvePromise()))
    }
  })
})
