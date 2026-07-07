// Runs on `npm install` (including `npm install -g github:ericnerwala/GraphCode`).
//
// A committed dist/ ships in the repo so git-source installs work even when the
// build toolchain (tsc) isn't available in the install environment. We rebuild
// only when tsc is actually present (dev checkouts, CI); otherwise we trust the
// committed dist/ rather than failing the whole install.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = join(root, 'dist', 'cli', 'main.js')

function tscAvailable() {
  const probe = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--version'], {
    stdio: 'ignore',
  })
  return probe.status === 0
}

if (tscAvailable()) {
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (build.status !== 0) process.exit(build.status ?? 1)
} else if (!existsSync(distEntry)) {
  process.stderr.write(
    'graphcode: no committed dist/ and no TypeScript compiler available — run `npm install` in a dev checkout and `npm run build`.\n',
  )
  process.exit(1)
} else {
  process.stderr.write('graphcode: using committed dist/ (TypeScript compiler not available to rebuild).\n')
}
