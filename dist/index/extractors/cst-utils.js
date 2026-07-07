/**
 * web-tree-sitter@0.25 types `namedChildren` (and similar accessors) as
 * `(Node | null)[]`. In practice tree-sitter never actually produces `null`
 * entries for these arrays, but the type must be narrowed. This helper
 * filters out any `null` entries so callers can keep using array methods
 * (`.find`, `.filter`, `for..of`, etc.) against a `Node[]`.
 */
export function namedKids(node) {
    return node.namedChildren.filter((child) => child !== null);
}
/**
 * Same null-filtering as {@link namedKids}, but for the results of
 * `descendantsOfType`, which is also typed as `(Node | null)[]` in 0.25.
 */
export function descendantsOf(node, types) {
    return node.descendantsOfType(types).filter((child) => child !== null);
}
