#!/usr/bin/env node
// GraphCode launcher. Re-executes with the ExperimentalWarning for node:sqlite
// silenced when possible, otherwise runs the CLI directly.
const MIN_MAJOR = 22
const MIN_MINOR = 5

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
  process.stderr.write(
    `graphcode requires Node >= ${MIN_MAJOR}.${MIN_MINOR} (node:sqlite). Found ${process.versions.node}.\n`,
  )
  process.exit(1)
}

process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return
  process.stderr.write(`${warning.name}: ${warning.message}\n`)
})

await import('../dist/cli/main.js')
