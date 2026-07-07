/** All CLI output funnels through here so library code never prints directly. */
export function print(text) {
    process.stdout.write(`${text}\n`);
}
export function printRaw(text) {
    process.stdout.write(text);
}
export function printError(text) {
    process.stderr.write(`${text}\n`);
}
export function printStatus(text) {
    if (process.env.GRAPHCODE_QUIET === '1')
        return;
    process.stderr.write(`${text}\n`);
}
