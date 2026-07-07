import { Command } from 'commander';
import { printError } from '../core/output.js';
import { GraphcodeError } from '../core/errors.js';
import { registerIndexCommands } from './commands/index-cmd.js';
import { registerQueryCommands } from './commands/query-cmds.js';
import { registerAgentCommand } from './commands/agent-cmd.js';
import { registerMcpCommand } from './commands/mcp-cmd.js';
import { registerExportCommands } from './commands/export-cmd.js';
import { registerStatsCommand } from './commands/stats-cmd.js';
import { registerAuthCommand } from './commands/auth-cmd.js';
const program = new Command();
program
    .name('graphcode')
    .description('The graph-native coding agent. Indexes your codebase as a knowledge graph — code structure, git history, docs, features — and puts it in front of the agent before the first token.')
    .version('0.1.0');
registerIndexCommands(program);
registerQueryCommands(program);
registerAgentCommand(program);
registerMcpCommand(program);
registerExportCommands(program);
registerStatsCommand(program);
registerAuthCommand(program);
async function main() {
    // Bare `graphcode` (no subcommand) runs the agent: sync the graph, then chat.
    const knownCommands = new Set(program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()]));
    const first = process.argv[2];
    const argv = first && !first.startsWith('-') && !knownCommands.has(first)
        ? process.argv
        : first === undefined || (first.startsWith('-') && first !== '--help' && first !== '-h' && first !== '--version' && first !== '-V')
            ? [...process.argv.slice(0, 2), 'agent', ...process.argv.slice(2)]
            : process.argv;
    await program.parseAsync(argv);
}
main().catch((error) => {
    if (error instanceof GraphcodeError) {
        printError(`error: ${error.message}`);
        if (error.hint)
            printError(`hint: ${error.hint}`);
    }
    else {
        printError(`unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    process.exitCode = 1;
});
