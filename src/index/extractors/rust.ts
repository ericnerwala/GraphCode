import type { Node, Tree } from 'web-tree-sitter'
import type { SymbolKind } from '../../graph/types.js'
import type { ExtractedImport, ExtractedRef, ExtractedSymbol, FileExtraction } from '../extract-types.js'
import { descendantsOf, namedKids } from './cst-utils.js'

const MAX_DOC_LEN = 200

function trimDoc(raw: string): string {
  const cleaned = raw
    .split('\n')
    .map((line) => line.replace(/^\/\/\/?!?\s?/, '').replace(/^\/\*\*?|\*\/$/g, ''))
    .join(' ')
    .trim()
  return cleaned.length > MAX_DOC_LEN ? `${cleaned.slice(0, MAX_DOC_LEN)}…` : cleaned
}

function leadingDoc(node: Node): string | undefined {
  let sibling = node.previousSibling
  const comments: string[] = []
  while (sibling && (sibling.type === 'line_comment' || sibling.type === 'block_comment')) {
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

/** Outer node including attributes (#[derive(...)] etc.) that precede the item. */
function outerWithAttributes(node: Node): Node {
  let start = node
  let sibling = start.previousSibling
  while (sibling && sibling.type === 'attribute_item') {
    start = sibling
    sibling = start.previousSibling
  }
  return start
}

function hasPubModifier(node: Node): boolean {
  return namedKids(node).some((c) => c.type === 'visibility_modifier') || /^pub(\s|\()/.test(node.text)
}

interface WalkContext {
  readonly symbols: ExtractedSymbol[]
  readonly refs: ExtractedRef[]
  readonly imports: ExtractedImport[]
}

function identifierRoot(node: Node): string {
  if (node.type === 'identifier' || node.type === 'type_identifier') return node.text
  const child = node.childForFieldName('function') ?? node.childForFieldName('type') ?? node.namedChild(0)
  if (child) return identifierRoot(child)
  return node.text.split(/[.:(<]/)[0] ?? node.text
}

function walkExpressionForRefs(node: Node | null, enclosing: string | null, ctx: WalkContext): void {
  if (!node) return
  for (const call of descendantsOf(node, ['call_expression'])) {
    const callee = call.childForFieldName('function')
    if (callee) ctx.refs.push({ fromSymbol: enclosing, name: identifierRoot(callee), kind: 'calls' })
  }
}

function qualify(parentName: string | undefined, name: string): string {
  return parentName ? `${parentName}.${name}` : name
}

function pushSymbol(
  ctx: WalkContext,
  node: Node,
  name: string,
  kind: SymbolKind,
  parentName: string | undefined,
): void {
  const outer = outerWithAttributes(node)
  ctx.symbols.push({
    name,
    kind,
    qualifiedName: qualify(parentName, name),
    startLine: line1(outer),
    endLine: lineEnd(node),
    signature: firstLine(node.text),
    doc: leadingDoc(outer),
    exported: hasPubModifier(node),
    parentName,
  })
}

function handleFn(node: Node, parentName: string | undefined, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  const name = nameNode.text
  pushSymbol(ctx, node, name, parentName ? 'method' : 'function', parentName)
  walkExpressionForRefs(node.childForFieldName('body'), name, ctx)
}

function handleStruct(node: Node, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  pushSymbol(ctx, node, nameNode.text, 'struct', undefined)
}

function handleEnum(node: Node, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  pushSymbol(ctx, node, nameNode.text, 'enum', undefined)
}

function handleTrait(node: Node, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  const name = nameNode.text
  pushSymbol(ctx, node, name, 'trait', undefined)
  const body = node.childForFieldName('body')
  if (!body) return
  for (const member of namedKids(body)) {
    if (member.type === 'function_item' || member.type === 'function_signature_item') handleFn(member, name, ctx)
  }
}

function typeNameOf(typeNode: Node | null): string | null {
  if (!typeNode) return null
  if (typeNode.type === 'type_identifier') return typeNode.text
  if (typeNode.type === 'generic_type') {
    const base = typeNode.childForFieldName('type') ?? typeNode.namedChild(0)
    return base ? typeNameOf(base) : null
  }
  if (typeNode.type === 'scoped_type_identifier') {
    const name = typeNode.childForFieldName('name')
    return name?.text ?? typeNode.text
  }
  return typeNode.text
}

function handleImpl(node: Node, ctx: WalkContext): void {
  const typeNode = node.childForFieldName('type')
  const traitNode = node.childForFieldName('trait')
  const typeName = typeNameOf(typeNode)
  if (!typeName) return

  ctx.symbols.push({
    name: typeName,
    kind: 'impl',
    qualifiedName: traitNode ? `${typeName} as ${typeNameOf(traitNode) ?? traitNode.text}` : `${typeName} impl`,
    startLine: line1(node),
    endLine: lineEnd(node),
    signature: firstLine(node.text),
    doc: leadingDoc(node),
    exported: false,
    parentName: typeName,
  })

  if (traitNode) {
    const traitName = typeNameOf(traitNode)
    if (traitName) ctx.refs.push({ fromSymbol: typeName, name: traitName, kind: 'implements' })
  }

  const body = node.childForFieldName('body')
  if (!body) return
  for (const member of namedKids(body)) {
    if (member.type === 'function_item') handleFn(member, typeName, ctx)
  }
}

function handleMod(node: Node, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  pushSymbol(ctx, node, nameNode.text, 'module', undefined)
  const body = node.childForFieldName('body')
  if (body) walkItems(body, ctx)
}

function handleUse(node: Node, ctx: WalkContext): void {
  const argument = namedKids(node).find((c) => c.type !== 'visibility_modifier')
  if (argument) ctx.imports.push({ raw: argument.text })
}

function walkItems(node: Node, ctx: WalkContext): void {
  for (const child of namedKids(node)) {
    switch (child.type) {
      case 'function_item':
        handleFn(child, undefined, ctx)
        break
      case 'struct_item':
        handleStruct(child, ctx)
        break
      case 'enum_item':
        handleEnum(child, ctx)
        break
      case 'trait_item':
        handleTrait(child, ctx)
        break
      case 'impl_item':
        handleImpl(child, ctx)
        break
      case 'mod_item':
        handleMod(child, ctx)
        break
      case 'use_declaration':
        handleUse(child, ctx)
        break
      default:
        break
    }
  }
}

/** Extract symbols, refs, and imports from a parsed Rust syntax tree. */
export function extractRust(tree: Tree): FileExtraction {
  const ctx: WalkContext = { symbols: [], refs: [], imports: [] }
  try {
    walkItems(tree.rootNode, ctx)
  } catch {
    return { symbols: [], refs: [], imports: [] }
  }
  return ctx
}
