import type { Node, Tree } from 'web-tree-sitter'
import type { ExtractedImport, ExtractedRef, ExtractedSymbol, FileExtraction } from '../extract-types.js'
import { descendantsOf, namedKids } from './cst-utils.js'

const MAX_DOC_LEN = 200

function trimDoc(raw: string): string {
  const cleaned = raw.replace(/^['"]{3}|['"]{3}$/g, '').trim()
  return cleaned.length > MAX_DOC_LEN ? `${cleaned.slice(0, MAX_DOC_LEN)}…` : cleaned
}

function docstringOf(bodyNode: Node | null): string | undefined {
  if (!bodyNode) return undefined
  const first = bodyNode.namedChild(0)
  if (!first || first.type !== 'expression_statement') return undefined
  const expr = first.namedChild(0)
  if (!expr || expr.type !== 'string') return undefined
  return trimDoc(expr.text)
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n')
  return (idx === -1 ? text : text.slice(0, idx)).trim()
}

function line1(node: Node): number {
  return node.startPosition.row + 1
}
function lineEnd(node: Node): number {
  return node.endPosition.row + 1
}

function qualify(parentName: string | undefined, name: string): string {
  return parentName ? `${parentName}.${name}` : name
}

interface WalkContext {
  readonly symbols: ExtractedSymbol[]
  readonly refs: ExtractedRef[]
  readonly imports: ExtractedImport[]
}

function identifierRoot(node: Node): string {
  if (node.type === 'identifier') return node.text
  const child = node.childForFieldName('object') ?? node.childForFieldName('function') ?? node.namedChild(0)
  if (child) return identifierRoot(child)
  return node.text.split(/[.([]/)[0] ?? node.text
}

/** Common Python builtins that show up constantly as call targets but never
 * resolve to a repo symbol; filtered so they don't leak into the graph as
 * junk cross-file "calls" edges. */
const PYTHON_BUILTINS = new Set([
  'print',
  'len',
  'range',
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'set',
  'tuple',
  'isinstance',
  'issubclass',
  'super',
  'open',
  'enumerate',
  'zip',
  'map',
  'filter',
  'sorted',
])

/**
 * Resolve a call's callee expression to the ref name. For `obj.method()` the
 * grammar names the target the `attribute` field (rightmost identifier) on
 * an `attribute` node — ref that, not the `object` operand, which is
 * frequently a local variable/instance rather than the thing being called.
 */
function calleeRefName(callee: Node): string {
  if (callee.type === 'attribute') {
    const attribute = callee.childForFieldName('attribute')
    if (attribute) return attribute.text
  }
  return identifierRoot(callee)
}

function walkExpressionForRefs(node: Node | null, enclosing: string | null, ctx: WalkContext): void {
  if (!node) return
  for (const call of descendantsOf(node, ['call'])) {
    const callee = call.childForFieldName('function')
    if (!callee) continue
    const name = calleeRefName(callee)
    if (PYTHON_BUILTINS.has(name)) continue
    ctx.refs.push({ fromSymbol: enclosing, name, kind: 'calls' })
  }
}

/** True if the def node (or the decorated_definition wrapping it) has a decorator. */
function outerNode(defNode: Node): Node {
  return defNode.parent?.type === 'decorated_definition' ? defNode.parent : defNode
}

function handleFunction(node: Node, parentName: string | undefined, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  const name = nameNode.text
  const outer = outerNode(node)
  const bodyNode = node.childForFieldName('body')
  const paramsNode = node.childForFieldName('parameters')
  const signature = `def ${name}${paramsNode ? paramsNode.text : '()'}`
  ctx.symbols.push({
    name,
    kind: parentName ? 'method' : 'function',
    qualifiedName: qualify(parentName, name),
    startLine: line1(outer),
    endLine: lineEnd(outer),
    signature,
    doc: docstringOf(bodyNode),
    exported: !name.startsWith('_'),
    parentName,
  })
  walkExpressionForRefs(bodyNode, name, ctx)
  // Nested defs (methods aren't nested funcs, but closures can appear) — skip for simplicity.
}

function handleClass(node: Node, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  const name = nameNode.text
  const outer = outerNode(node)
  const bodyNode = node.childForFieldName('body')
  ctx.symbols.push({
    name,
    kind: 'class',
    qualifiedName: name,
    startLine: line1(outer),
    endLine: lineEnd(outer),
    signature: `class ${name}`,
    doc: docstringOf(bodyNode),
    exported: !name.startsWith('_'),
  })
  const superclasses = node.childForFieldName('superclasses')
  if (superclasses) {
    for (const arg of namedKids(superclasses)) {
      if (arg.type === 'identifier' || arg.type === 'attribute') {
        ctx.refs.push({ fromSymbol: name, name: identifierRoot(arg), kind: 'extends' })
      }
    }
  }
  if (bodyNode) {
    for (const member of namedKids(bodyNode)) {
      const target = member.type === 'decorated_definition' ? namedKids(member).at(-1) : member
      if (target?.type === 'function_definition') handleFunction(target, name, ctx)
    }
  }
}

function handleImport(node: Node, ctx: WalkContext): void {
  if (node.type === 'import_statement') {
    for (const child of namedKids(node)) {
      if (child.type === 'dotted_name' || child.type === 'aliased_import') {
        const nameNode = child.type === 'aliased_import' ? child.childForFieldName('name') : child
        if (nameNode) ctx.imports.push({ raw: nameNode.text })
      }
    }
  } else if (node.type === 'import_from_statement') {
    const moduleNode = node.childForFieldName('module_name')
    if (moduleNode) ctx.imports.push({ raw: moduleNode.text })
  }
}

function walkTopLevel(node: Node, ctx: WalkContext): void {
  for (const child of namedKids(node)) {
    const target = child.type === 'decorated_definition' ? (namedKids(child).at(-1) ?? child) : child
    if (target.type === 'function_definition') {
      handleFunction(target, undefined, ctx)
    } else if (target.type === 'class_definition') {
      handleClass(target, ctx)
    } else if (target.type === 'import_statement' || target.type === 'import_from_statement') {
      handleImport(target, ctx)
    } else if (target.type === 'expression_statement') {
      walkExpressionForRefs(target, null, ctx)
    }
  }
}

/** Extract symbols, refs, and imports from a parsed Python syntax tree. */
export function extractPython(tree: Tree): FileExtraction {
  const ctx: WalkContext = { symbols: [], refs: [], imports: [] }
  try {
    walkTopLevel(tree.rootNode, ctx)
  } catch {
    return { symbols: [], refs: [], imports: [] }
  }
  return ctx
}
