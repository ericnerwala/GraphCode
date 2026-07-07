/** All CLI output funnels through here so library code never prints directly. */

export function print(text: string): void {
  process.stdout.write(`${text}\n`)
}

export function printRaw(text: string): void {
  process.stdout.write(text)
}

export function printError(text: string): void {
  process.stderr.write(`${text}\n`)
}

export function printStatus(text: string): void {
  if (process.env.GRAPHCODE_QUIET === '1') return
  process.stderr.write(`${text}\n`)
}
