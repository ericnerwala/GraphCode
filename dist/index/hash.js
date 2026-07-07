import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
/** SHA-256 hex digest of a file's contents, read lazily. */
export async function hashFile(path) {
    const contents = await readFile(path);
    return hashContent(contents);
}
/** SHA-256 hex digest of in-memory content (string or bytes). */
export function hashContent(content) {
    return createHash('sha256').update(content).digest('hex');
}
