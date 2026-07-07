/** Split a code identifier into searchable terms: camelCase, PascalCase,
 * snake_case, kebab-case, SCREAMING_CASE, and digit boundaries. */
export function splitIdentifier(identifier) {
    const parts = identifier
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^A-Za-z\d]+/)
        .filter((part) => part.length > 1);
    return [...new Set(parts.map((part) => part.toLowerCase()))];
}
/** Basename without extension, e.g. "src/core/Clock.ts" -> "Clock". */
export function fileBasename(path) {
    const base = path.split('/').at(-1) ?? path;
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}
