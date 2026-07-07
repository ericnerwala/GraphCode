import type { Node, Tree } from 'web-tree-sitter'
import type { SymbolKind } from '../../graph/types.js'
import type { ExtractedImport, ExtractedRef, ExtractedSymbol, FileExtraction } from '../extract-types.js'
import { descendantsOf, namedKids } from './cst-utils.js'

const MAX_DOC_LEN = 200

function trimDoc(raw: string): string {
  const cleaned = raw
    .replace(/^\/\*\*?|\*\/$/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join(' ')
    .trim()
  return cleaned.length > MAX_DOC_LEN ? `${cleaned.slice(0, MAX_DOC_LEN)}…` : cleaned
}

function leadingDoc(node: Node): string | undefined {
  let sibling = node.previousSibling
  // Skip over modifier/annotation nodes that tree-sitter-java attaches as siblings.
  while (sibling && (sibling.type === 'modifiers' || sibling.type === 'annotation')) {
    sibling = sibling.previousSibling
  }
  if (sibling && (sibling.type === 'block_comment' || sibling.type === 'line_comment')) {
    return trimDoc(sibling.text)
  }
  return undefined
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

function hasPublicModifier(node: Node): boolean {
  const modifiers = namedKids(node).find((c) => c.type === 'modifiers')
  if (!modifiers) return false
  // The "public" keyword is an unnamed (anonymous) token in tree-sitter-java's
  // grammar (type "public", not wrapped in a named "modifier" node), so it
  // won't show up via namedChildren text equality — fall back to a raw-text
  // check against the modifiers node itself.
  return namedKids(modifiers).some((c) => c.text === 'public') || /(^|\s)public(\s|$)/.test(modifiers.text)
}

interface WalkContext {
  readonly symbols: ExtractedSymbol[]
  readonly refs: ExtractedRef[]
  readonly imports: ExtractedImport[]
  packageName?: string
}

function identifierRoot(node: Node): string {
  if (node.type === 'identifier') return node.text
  const child = node.childForFieldName('object') ?? node.childForFieldName('name') ?? node.namedChild(0)
  if (child) return identifierRoot(child)
  return node.text.split(/[.(<]/)[0] ?? node.text
}

function walkExpressionForRefs(node: Node | null, enclosing: string | null, ctx: WalkContext): void {
  if (!node) return
  for (const call of descendantsOf(node, ['method_invocation'])) {
    const nameNode = call.childForFieldName('name')
    if (nameNode) ctx.refs.push({ fromSymbol: enclosing, name: nameNode.text, kind: 'calls' })
  }
  for (const create of descendantsOf(node, ['object_creation_expression'])) {
    const typeNode = create.childForFieldName('type')
    if (typeNode) ctx.refs.push({ fromSymbol: enclosing, name: identifierRoot(typeNode), kind: 'calls' })
  }
}

function typeListNames(clause: Node): string[] {
  // `clause` is a `super_interfaces` node whose single named child is a
  // `type_list` wrapping the actual type nodes; unwrap it before filtering.
  const typeList = namedKids(clause).find((c) => c.type === 'type_list') ?? clause
  return namedKids(typeList)
    .filter((c) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier')
    .map((c) => identifierRoot(c))
}

function handleTypeDecl(node: Node, kind: SymbolKind, ctx: WalkContext, parentName: string | undefined): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  const name = nameNode.text
  const qualifiedName = parentName ? `${parentName}.${name}` : name
  ctx.symbols.push({
    name,
    kind,
    qualifiedName,
    startLine: line1(node),
    endLine: lineEnd(node),
    signature: firstLine(node.text),
    doc: leadingDoc(node),
    exported: hasPublicModifier(node),
    parentName,
  })

  const superclass = node.childForFieldName('superclass')
  if (superclass) {
    for (const child of namedKids(superclass)) {
      ctx.refs.push({ fromSymbol: name, name: identifierRoot(child), kind: 'extends' })
    }
  }
  const interfaces = node.childForFieldName('interfaces')
  if (interfaces) {
    for (const typeName of typeListNames(interfaces)) {
      ctx.refs.push({ fromSymbol: name, name: typeName, kind: 'implements' })
    }
  }

  const body = node.childForFieldName('body')
  if (!body) return
  for (const member of namedKids(body)) {
    if (member.type === 'method_declaration' || member.type === 'constructor_declaration') {
      handleMethod(member, name, ctx)
    } else if (member.type === 'field_declaration') {
      handleField(member, name, ctx)
    } else if (member.type === 'class_declaration') {
      handleTypeDecl(member, 'class', ctx, name)
    } else if (member.type === 'interface_declaration') {
      handleTypeDecl(member, 'interface', ctx, name)
    } else if (member.type === 'enum_declaration') {
      handleTypeDecl(member, 'enum', ctx, name)
    }
  }
}

function handleMethod(node: Node, className: string, ctx: WalkContext): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  const name = nameNode.text
  const params = node.childForFieldName('parameters')
  ctx.symbols.push({
    name,
    kind: 'method',
    qualifiedName: `${className}.${name}`,
    startLine: line1(node),
    endLine: lineEnd(node),
    signature: firstLine(`${name}${params ? params.text : '()'}`),
    doc: leadingDoc(node),
    exported: hasPublicModifier(node),
    parentName: className,
  })
  walkExpressionForRefs(node.childForFieldName('body'), name, ctx)
}

function handleField(node: Node, className: string, ctx: WalkContext): void {
  const declarators = namedKids(node).filter((c) => c.type === 'variable_declarator')
  for (const declarator of declarators) {
    const nameNode = declarator.childForFieldName('name')
    if (!nameNode) continue
    ctx.symbols.push({
      name: nameNode.text,
      kind: 'variable',
      qualifiedName: `${className}.${nameNode.text}`,
      startLine: line1(node),
      endLine: lineEnd(node),
      signature: firstLine(node.text),
      doc: leadingDoc(node),
      exported: hasPublicModifier(node),
      parentName: className,
    })
  }
}

function handleImport(node: Node, ctx: WalkContext): void {
  const kids = namedKids(node)
  const scopedName = kids.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier')
  if (!scopedName) return
  const isWildcard = kids.some((c) => c.type === 'asterisk')
  const isStatic = node.text.trimStart().startsWith('import static')
  // Static member imports (`import static a.b.C.member;` / `.*;`) name a
  // member of a class rather than a package or class itself — resolving
  // them would require distinguishing the trailing segment as a member vs.
  // a class, which the bare FQCN text can't disambiguate. Skip them rather
  // than mis-resolve; a known limitation (see mission report).
  if (isStatic) return
  ctx.imports.push({ raw: isWildcard ? `${scopedName.text}.*` : scopedName.text })
}

function handlePackage(node: Node, ctx: WalkContext): void {
  const scopedName = namedKids(node).find((c) => c.type === 'scoped_identifier' || c.type === 'identifier')
  if (scopedName) ctx.packageName = scopedName.text
}

function walkTopLevel(node: Node, ctx: WalkContext): void {
  for (const child of namedKids(node)) {
    switch (child.type) {
      case 'class_declaration':
        handleTypeDecl(child, 'class', ctx, undefined)
        break
      case 'interface_declaration':
        handleTypeDecl(child, 'interface', ctx, undefined)
        break
      case 'enum_declaration':
        handleTypeDecl(child, 'enum', ctx, undefined)
        break
      case 'import_declaration':
        handleImport(child, ctx)
        break
      case 'package_declaration':
        handlePackage(child, ctx)
        break
      default:
        break
    }
  }
}

/** Extract symbols, refs, imports, and package decl from a parsed Java syntax tree. */
export function extractJava(tree: Tree): FileExtraction {
  const ctx: WalkContext = { symbols: [], refs: [], imports: [] }
  try {
    walkTopLevel(tree.rootNode, ctx)
  } catch {
    return { symbols: [], refs: [], imports: [] }
  }
  return { symbols: ctx.symbols, refs: ctx.refs, imports: ctx.imports, packageName: ctx.packageName }
}
