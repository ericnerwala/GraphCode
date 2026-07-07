// A minimal stand-in for web-tree-sitter's Node, covering exactly the surface
// our extractors use (type/text/position/field lookups/sibling & parent links).
// This lets extractor logic be unit-tested without a working wasm grammar —
// useful in environments where tree-sitter grammars can't load (see
// helpers/wasm-support.ts) but also as a fast, precise way to pin down CST
// shapes the extractors must handle.

export interface FakeNodeSpec {
  readonly type: string
  readonly text?: string
  /** 1-based start line; converted to the zero-based row tree-sitter uses. */
  readonly startLine?: number
  readonly endLine?: number
  readonly fields?: Readonly<Record<string, FakeNodeSpec | FakeNodeSpec[] | undefined>>
  readonly children?: readonly FakeNodeSpec[]
}

export interface FakeNode {
  readonly type: string
  readonly text: string
  readonly startPosition: { row: number; column: number }
  readonly endPosition: { row: number; column: number }
  readonly namedChildren: FakeNode[]
  readonly namedChildCount: number
  parent: FakeNode | null
  previousSibling: FakeNode | null
  nextSibling: FakeNode | null
  namedChild(index: number): FakeNode | null
  childForFieldName(name: string): FakeNode | null
  childrenForFieldName(name: string): FakeNode[]
  descendantsOfType(types: string | string[]): FakeNode[]
}

/** Build a fake Node tree from a plain spec object. Wires parent/sibling links. */
export function fakeNode(spec: FakeNodeSpec): FakeNode {
  const fieldMap = new Map<string, FakeNode | FakeNode[]>()
  const namedChildren: FakeNode[] = []

  const node: FakeNode = {
    type: spec.type,
    text: spec.text ?? '',
    startPosition: { row: (spec.startLine ?? 1) - 1, column: 0 },
    endPosition: { row: (spec.endLine ?? spec.startLine ?? 1) - 1, column: 0 },
    namedChildren,
    get namedChildCount() {
      return namedChildren.length
    },
    parent: null,
    previousSibling: null,
    nextSibling: null,
    namedChild(index: number) {
      return namedChildren[index] ?? null
    },
    childForFieldName(name: string) {
      const value = fieldMap.get(name)
      if (Array.isArray(value)) return value[0] ?? null
      return value ?? null
    },
    childrenForFieldName(name: string) {
      const value = fieldMap.get(name)
      if (!value) return []
      return Array.isArray(value) ? value : [value]
    },
    descendantsOfType(types: string | string[]) {
      const wanted = Array.isArray(types) ? types : [types]
      const results: FakeNode[] = []
      const visit = (n: FakeNode) => {
        if (wanted.includes(n.type)) results.push(n)
        for (const child of n.namedChildren) visit(child)
      }
      for (const child of namedChildren) visit(child)
      return results
    },
  }

  if (spec.fields) {
    for (const [key, value] of Object.entries(spec.fields)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        const built = value.map((v) => buildAndAttach(v, node))
        fieldMap.set(key, built)
        namedChildren.push(...built)
      } else {
        const built = buildAndAttach(value, node)
        fieldMap.set(key, built)
        namedChildren.push(built)
      }
    }
  }

  if (spec.children) {
    for (const childSpec of spec.children) {
      namedChildren.push(buildAndAttach(childSpec, node))
    }
  }

  linkSiblings(namedChildren)
  return node
}

function buildAndAttach(spec: FakeNodeSpec, parent: FakeNode): FakeNode {
  const child = fakeNode(spec)
  child.parent = parent
  return child
}

function linkSiblings(nodes: readonly FakeNode[]): void {
  for (let i = 0; i < nodes.length; i += 1) {
    const prev = nodes[i - 1]
    const next = nodes[i + 1]
    const current = nodes[i]
    if (!current) continue
    current.previousSibling = prev ?? null
    current.nextSibling = next ?? null
  }
}

/** Wrap a root FakeNode as a fake Tree (only `.rootNode` is used by extractors). */
export function fakeTree(root: FakeNode): { rootNode: FakeNode } {
  return { rootNode: root }
}
