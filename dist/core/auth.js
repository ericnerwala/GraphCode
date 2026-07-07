// Stored-credential auth for the built-in agent, following the opencode/pi
// login/status/logout UX: env vars still win, but a missing key falls back
// to a small JSON file under the user's config dir instead of a hard error.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
function configDir() {
    const xdg = process.env.XDG_CONFIG_HOME;
    return xdg && xdg.length > 0 ? join(xdg, 'graphcode') : join(homedir(), '.config', 'graphcode');
}
function authFilePath() {
    return join(configDir(), 'auth.json');
}
function readAuthFile() {
    const path = authFilePath();
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** Precedence: ANTHROPIC_API_KEY env, then CLAUDE_API_KEY env, then the stored auth file. */
export function resolveApiKey() {
    const envKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY;
    if (envKey)
        return { key: envKey, source: 'env' };
    const fileKey = readAuthFile()?.anthropic?.apiKey;
    if (fileKey)
        return { key: fileKey, source: 'auth-file' };
    return null;
}
/** True if a key would resolve from either an env var or the auth file. */
export function hasApiKey() {
    return resolveApiKey() !== null;
}
/** Persists the key to `~/.config/graphcode/auth.json` (or $XDG_CONFIG_HOME) with 0600
 * permissions. Non-`sk-` prefixed keys are accepted but flagged with a warning. */
export function saveApiKey(key) {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
        throw new Error('API key must not be empty.');
    }
    const dir = configDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = authFilePath();
    const contents = { anthropic: { apiKey: trimmed } };
    writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
    // `mode` on writeFileSync only applies when creating a new file; force it in case the
    // auth file already existed (e.g. re-running `auth login` to replace the key).
    chmodSync(path, 0o600);
    return trimmed.startsWith('sk-')
        ? { path }
        : { path, warning: `Key doesn't start with "sk-" — double check you pasted an Anthropic API key.` };
}
/** Deletes the stored auth file, if any. Returns whether a file was actually removed. */
export function clearApiKey() {
    const path = authFilePath();
    if (!existsSync(path))
        return false;
    rmSync(path);
    return true;
}
function maskKey(key) {
    if (key.length <= 8)
        return '***';
    return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
/** Summarizes the currently resolved key (if any) for `graphcode auth status`. */
export function authStatus() {
    const resolved = resolveApiKey();
    if (!resolved)
        return { configured: false };
    return { configured: true, source: resolved.source, masked: maskKey(resolved.key) };
}
export function getAuthFilePath() {
    return authFilePath();
}
export function getConfigDir() {
    return configDir();
}
