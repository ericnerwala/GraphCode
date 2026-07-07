import type { Node, Tree } from 'web-tree-sitter'
import type { ExtractedImport, ExtractedRef, ExtractedSymbol, FileExtraction } from '../extract-types.js'
import { descendantsOf, namedKids } from './cst-utils.js'

const MAX_DOC_LEN = 200

function trimDoc(raw: string): string {
  const cleaned = raw
    .split('\n')
    .map((line) => line.replace(/^\/\/\s?/, ''))
    .join(' ')
    .trim()
  return cleaned.length > MAX_DOC_LEN ? `${cleaned.slice(0, MAX_DOC_LEN)}…` : cleaned
}

function leadingDoc(node: Node): string | undefined {
  let sibling = node.previousSibling
  const comments: string[] = []
  while (sibling && sibling.type === 'comment') {
    comments.unshift(sibling.text)
    sibling = sibling.previousSibling
  }
  if (comments.length === 0) return undefined
  return trimDoc(comments.join('\n'))
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

function isExported(name: string): boolean {
  return /^[A-Z]/.test(name)
}

interface WalkContext {
  readonly symbols: ExtractedSymbol[]
  readonly refs: ExtractedRef[]
  readonly imports: ExtractedImport[]
}

/**
 * Go builtins that show up constantly as call targets but never resolve to a
 * repo symbol; filtered at the extractor boundary so they don't leak into the
 * graph as junk cross-file "calls" edges (e.g. every `append()` call landing
 * on an unrelated symbol that happens to share the name).
 */
const GO_BUILTINS = new Set([
  'append',
  'len',
  'cap',
  'make',
  'new',
  'copy',
  'delete',
  'close',
  'panic',
  'recover',
  'print',
  'println',
])

/** Resolve a (possibly qualified/pointer) type expression down to its root type name. */
function identifierRoot(node: Node): string {
  if (node.type === 'identifier' || node.type === 'type_identifier') return node.text
  if (node.type === 'qualified_type') {
    const name = node.childForFieldName('name')
    if (name) return name.text
  }
  const child = node.childForFieldName('operand') ?? node.childForFieldName('function') ?? node.namedChild(0)
  if (child) return identifierRoot(child)
  return node.text.split(/[.(]/)[0] ?? node.text
}

/**
 * Resolve a call's callee expression to the ref name. For a bare identifier
 * this is the identifier itself; for a selector (`pkg.Func`, `recv.Method`)
 * Go's grammar always names the target the field (rightmost identifier), so
 * we must ref that field name, never the operand — the operand is frequently
 * a local variable (e.g. `nn := namenode.New(...); nn.Serve()` must ref
 * `Serve`, not `nn`).
 */
function calleeRefName(callee: Node): string {
  if (callee.type === 'selector_expression') {
    const field = callee.childForFieldName('field')
    if (field) return field.text
  }
  return identifierRoot(callee)
}

function walkExpressionForRefs(node: Node | null, enclosing: string | null, ctx: WalkContext): void {
  if (!node) return
  for (const call of descendantsOf(node, ['call_expression'])) {
    const callee = call.childForFieldName('function')
    if (!callee) continue
    const name = calleeRefName(callee)
    if (GO_BUILTINS.has(name)) continue
    ctx.refs.push({ fromSymbol: enclosing, name, kind: 'calls' })
  }
  for (const composite of descendantsOf(node, ['composite_literal'])) {
    const typeNode = composite.childForFieldName('type')
    if (!typeNode) continue
    const root = typeNode.type === 'pointer_type' ? (typeNode.namedChild(0) ?? typeNode) : typeNode
    if (root.type === 'type_identifier' || root.type === 'qualified_type') {
      ctx.refs.push({ fromSymbol: enclosing, name: identifierRoot(root), kind: 'references' })
    }
  }
  for (const varDecl of descendantsOf(node, ['var_spec', 'const_spec', 'parameter_declaration'])) {
    const typeNode = varDecl.childForFieldName('type')
    if (!typeNode) continue
    const root = typeNode.type === 'pointer_type' ? (typeNode.namedChild(0) ?? typeNode) : typeNode
    if (root.type === 'type_identifier' || root.type === 'qualified_type') {
      ctx.refs.push({ fromSymbol: enclosing, name: identifierRoot(root), kind: 'references' })
    }
  }
  for (const assertion of descendantsOf(node, ['type_assertion_expression'])) {
    const typeNode = assertion.childForFieldName('type')
    if (!typeNode) continue
    const root = typeNode.type === 'pointer_type' ? (typeNode.namedChild(0) ?? typeNode) : typeNode
    if (root.type === 'type_identifier' || root.type === 'qualified_type') {
      ctx.refs.push({ fromSymbol: enclosing, name: identifierRoot(root), kind: 'references' })
    }
  }
}

/** Extract the base type name from a receiver field ("r *Foo" -> "Foo"). */
function receiverTypeName(receiverNode: Node): string | null {
  const paramList = namedKids(receiverNode)
  for (const param of paramList) {
    const typeNode = param.childForFieldName('type')
    if (!typeNode) continue
    const root = typeNode.type === 'pointer_type' ? typeNode.namedChild(0) : typeNode
    if (root?.type === 'type_identifier') return root.text
  }
  return null
}

/** Type identifiers used as parameter/result types (`func f(x *NameNode) Widget`). */
function referenceParamAndResultTypes(paramsNode: Node | null, resultNode: Node | null, enclosing: string, ctx: WalkContext): void {
  for (const param of paramsNode ? descendantsOf(paramsNode, ['parameter_declaration']) : []) {
    const typeNode = param.childForFieldName('type')
    if (!typeNode) continue
    const root = typeNode.type === 'pointer_type' ? (typeNode.namedChild(0) ?? typeNode) : typeNode
    if (root.type === 'type_identifier' || root.type === 'qualified_type') {
      ctx.refs.push({ fromSymbol: enclosing, name: identifierRoot(root), kind: 'references' })
    }
  }
  if (resultNode) {
    const root = resultNode.type === 'pointer_type' ? (resultNode.namedChild(0) ?? resultNode) : resultNode
    if (root.type === 'type_identifier' || root.type === 'qualified_type') {
      ctx.refs.push({ fromSymbol: enclosing, name: identifierRoot(root), kind: 'references' })
    }
  }
}

function handleFuncDecl(node: Node, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  const name = nameNode.text
  const receiver = node.childForFieldName('receiver')
  const parentName = receiver ? (receiverTypeName(receiver) ?? undefined) : undefined
  const paramsNode = node.childForFieldName('parameters')
  const resultNode = node.childForFieldName('result')
  const signature = `func ${receiver ? `(${receiver.text}) ` : ''}${name}${paramsNode ? paramsNode.text : '()'}${resultNode ? ` ${resultNode.text}` : ''}`
  ctx.symbols.push({
    name,
    kind: parentName ? 'method' : 'function',
    qualifiedName: parentName ? `${parentName}.${name}` : name,
    startLine: line1(node),
    endLine: lineEnd(node),
    signature: firstLine(signature),
    doc: leadingDoc(node),
    exported: isExported(name),
    parentName,
  })
  referenceParamAndResultTypes(paramsNode, resultNode, name, ctx)
  walkExpressionForRefs(node.childForFieldName('body'), name, ctx)
}

function handleTypeSpec(node: Node, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name')
  const typeNode = node.childForFieldName('type')
  if (!nameNode || !typeNode) return
  const name = nameNode.text
  const kind = typeNode.type === 'struct_type' ? 'struct' : typeNode.type === 'interface_type' ? 'interface' : 'type'
  const outer = node.parent?.type === 'type_declaration' && node.parent.namedChildCount === 1 ? node.parent : node
  ctx.symbols.push({
    name,
    kind,
    qualifiedName: name,
    startLine: line1(outer),
    endLine: lineEnd(outer),
    signature: `type ${name} ${typeNode.type === 'struct_type' ? 'struct' : typeNode.type === 'interface_type' ? 'interface' : typeNode.text}`,
    doc: leadingDoc(outer),
    exported: isExported(name),
  })
  if (typeNode.type === 'struct_type') {
    const fieldList = typeNode.childForFieldName('body') ?? namedKids(typeNode).find((c) => c.type === 'field_declaration_list')
    if (fieldList) {
      for (const field of namedKids(fieldList)) {
        if (field.type !== 'field_declaration') continue
        // Embedded field: no explicit "name" field, just a type identifier/qualified type.
        const fieldNameNode = field.childForFieldName('name')
        if (!fieldNameNode) {
          const typeRef = field.childForFieldName('type') ?? field.namedChild(0)
          if (typeRef) ctx.refs.push({ fromSymbol: name, name: identifierRoot(typeRef), kind: 'extends' })
          continue
        }
        // Named field: reference its type (e.g. `ns *namespace` inside NameNode).
        const typeNode = field.childForFieldName('type')
        if (!typeNode) continue
        const root = typeNode.type === 'pointer_type' ? (typeNode.namedChild(0) ?? typeNode) : typeNode
        if (root.type === 'type_identifier' || root.type === 'qualified_type') {
          ctx.refs.push({ fromSymbol: name, name: identifierRoot(root), kind: 'references' })
        }
      }
    }
  } else if (typeNode.type === 'interface_type') {
    for (const elem of namedKids(typeNode)) {
      if (elem.type === 'type_identifier' || elem.type === 'qualified_type') {
        ctx.refs.push({ fromSymbol: name, name: identifierRoot(elem), kind: 'extends' })
      }
    }
  }
}

function handleImportSpec(node: Node, ctx: WalkContext): void {
  const pathNode = node.childForFieldName('path')
  if (!pathNode) return
  const raw = pathNode.text.replace(/^"|"$/g, '')
  ctx.imports.push({ raw })
}

function handleTopLevelVarConst(node: Node, kind: 'variable' | 'constant', ctx: WalkContext): void {
  for (const spec of namedKids(node)) {
    if (spec.type !== 'var_spec' && spec.type !== 'const_spec') continue
    const nameNodes = spec.childrenForFieldName('name').filter((n): n is Node => n !== null)
    for (const nameNode of nameNodes) {
      const name = nameNode.text
      ctx.symbols.push({
        name,
        kind,
        qualifiedName: name,
        startLine: line1(spec),
        endLine: lineEnd(spec),
        signature: firstLine(spec.text),
        doc: leadingDoc(node),
        exported: isExported(name),
      })
    }
  }
}

function walkTopLevel(node: Node, ctx: WalkContext): void {
  for (const child of namedKids(node)) {
    switch (child.type) {
      case 'function_declaration':
      case 'method_declaration':
        handleFuncDecl(child, ctx)
        break
      case 'type_declaration':
        for (const spec of namedKids(child)) {
          if (spec.type === 'type_spec') handleTypeSpec(spec, ctx)
        }
        break
      case 'import_declaration':
        for (const spec of namedKids(child)) {
          if (spec.type === 'import_spec') handleImportSpec(spec, ctx)
          else if (spec.type === 'import_spec_list') {
            for (const inner of namedKids(spec)) handleImportSpec(inner, ctx)
          }
        }
        break
      case 'var_declaration':
        handleTopLevelVarConst(child, 'variable', ctx)
        break
      case 'const_declaration':
        handleTopLevelVarConst(child, 'constant', ctx)
        break
      default:
        break
    }
  }
}

/** Extract symbols, refs, and imports from a parsed Go syntax tree. */
export function extractGo(tree: Tree): FileExtraction {
  const ctx: WalkContext = { symbols: [], refs: [], imports: [] }
  try {
    walkTopLevel(tree.rootNode, ctx)
  } catch {
    return { symbols: [], refs: [], imports: [] }
  }
  return ctx
}
