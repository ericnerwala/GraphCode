// Copies non-TS assets (schema.sql, viewer.html) into dist after tsc build.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const assets = [
  ['src/graph/schema.sql', 'dist/graph/schema.sql'],
  ['src/viz/viewer.html', 'dist/viz/viewer.html'],
]

for (const [from, to] of assets) {
  const src = join(root, from)
  if (!existsSync(src)) continue
  mkdirSync(dirname(join(root, to)), { recursive: true })
  copyFileSync(src, join(root, to))
}
