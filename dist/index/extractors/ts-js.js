import { descendantsOf, namedKids } from './cst-utils.js';
const MAX_DOC_LEN = 200;
function trimDoc(raw) {
    const cleaned = raw
        .replaceAll(/^\/\*\*?|\*\/$/g, '')
        .split('\n')
        .map((line) => line.replace(/^\s*\*?\s?/, '').replace(/^\/\/\s?/, ''))
        .join(' ')
        .trim();
    return cleaned.length > MAX_DOC_LEN ? `${cleaned.slice(0, MAX_DOC_LEN)}…` : cleaned;
}
/** Find a leading comment node immediately preceding `node`, if any. */
function leadingDoc(node) {
    let sibling = node.previousSibling;
    const comments = [];
    while (sibling && (sibling.type === 'comment' || sibling.type === 'line_comment')) {
        comments.unshift(sibling.text);
        sibling = sibling.previousSibling;
    }
    if (comments.length === 0)
        return undefined;
    return trimDoc(comments.join('\n'));
}
function firstLine(text) {
    const idx = text.indexOf('\n');
    const line = idx === -1 ? text : text.slice(0, idx);
    return line.trim();
}
function nameOf(node) {
    const nameNode = node.childForFieldName('name');
    return nameNode?.text ?? null;
}
function isExportedNode(node) {
    let current = node;
    while (current) {
        if (current.type === 'export_statement')
            return true;
        if (current.type.endsWith('_declaration') || current.type === 'lexical_declaration' || current.type === 'variable_declaration') {
            current = current.parent;
            continue;
        }
        if (current.type === 'class_body' || current.type === 'program' || current.type === 'statement_block')
            break;
        current = current.parent;
    }
    return false;
}
function line1(node) {
    return node.startPosition.row + 1;
}
function lineEnd(node) {
    return node.endPosition.row + 1;
}
function qualify(parentName, name) {
    return parentName ? `${parentName}.${name}` : name;
}
function pushSymbol(ctx, node, name, kind, parentName, signatureNode = node) {
    ctx.symbols.push({
        name,
        kind,
        qualifiedName: qualify(parentName, name),
        startLine: line1(node),
        endLine: lineEnd(node),
        signature: firstLine(signatureNode.text),
        doc: leadingDoc(isExportedNode(node) ? (node.parent?.type === 'export_statement' ? node.parent : node) : node),
        exported: isExportedNode(node),
        parentName,
    });
}
function extractHeritage(node, className, ctx) {
    const heritage = node.childForFieldName('heritage') ?? namedKids(node).find((c) => c.type === 'class_heritage');
    if (!heritage)
        return;
    for (const clause of namedKids(heritage)) {
        if (clause.type === 'extends_clause') {
            for (const child of namedKids(clause)) {
                ctx.refs.push({ fromSymbol: className, name: identifierRoot(child), kind: 'extends' });
            }
        }
        else if (clause.type === 'implements_clause') {
            for (const child of namedKids(clause)) {
                ctx.refs.push({ fromSymbol: className, name: identifierRoot(child), kind: 'implements' });
            }
        }
    }
}
/** Resolve a (possibly generic/member) type expression down to its root identifier text. */
function identifierRoot(node) {
    if (node.type === 'identifier' || node.type === 'type_identifier')
        return node.text;
    const expr = node.childForFieldName('expression') ?? node.namedChild(0);
    if (expr)
        return identifierRoot(expr);
    return node.text.split(/[.<(]/)[0] ?? node.text;
}
/**
 * Resolve a call/new callee expression to the ref name. For `obj.method()` or
 * `ns.Widget()` the grammar names the target the property (rightmost
 * identifier) via `member_expression`'s `property` field — ref that, not the
 * `object` operand, which is frequently a local variable/instance rather than
 * the thing actually being called.
 */
function calleeRefName(callee) {
    if (callee.type === 'member_expression') {
        const property = callee.childForFieldName('property');
        if (property)
            return property.text;
    }
    return identifierRoot(callee);
}
function walkClassBody(classNode, className, ctx) {
    const body = classNode.childForFieldName('body');
    if (!body)
        return;
    for (const member of namedKids(body)) {
        if (member.type === 'method_definition') {
            const name = nameOf(member);
            if (!name)
                continue;
            pushSymbol(ctx, member, name, 'method', className);
            walkExpressionForRefs(member.childForFieldName('body'), name, ctx);
        }
        else if (member.type === 'public_field_definition' || member.type === 'field_definition') {
            const name = nameOf(member);
            if (!name)
                continue;
            const valueNode = member.childForFieldName('value');
            if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function' || valueNode.type === 'function_expression')) {
                pushSymbol(ctx, member, name, 'method', className, member);
                walkExpressionForRefs(valueNode.childForFieldName('body'), name, ctx);
            }
        }
    }
}
function walkExpressionForRefs(node, enclosing, ctx) {
    if (!node)
        return;
    for (const call of descendantsOf(node, ['call_expression', 'new_expression'])) {
        const callee = call.childForFieldName('function') ?? call.childForFieldName('constructor');
        if (!callee)
            continue;
        ctx.refs.push({ fromSymbol: enclosing, name: calleeRefName(callee), kind: 'calls' });
    }
}
function handleFunctionDeclaration(node, ctx) {
    const name = nameOf(node);
    if (!name)
        return;
    pushSymbol(ctx, node, name, 'function', undefined);
    walkExpressionForRefs(node.childForFieldName('body'), name, ctx);
}
function handleArrowConst(declarator, ctx) {
    const nameNode = declarator.childForFieldName('name');
    const valueNode = declarator.childForFieldName('value');
    if (!nameNode || !valueNode)
        return;
    const isFn = valueNode.type === 'arrow_function' || valueNode.type === 'function' || valueNode.type === 'function_expression';
    const decl = declarator.parent ?? declarator;
    const name = nameNode.text;
    pushSymbol(ctx, decl, name, isFn ? 'function' : 'constant', undefined, declarator);
    if (isFn)
        walkExpressionForRefs(valueNode.childForFieldName('body'), name, ctx);
}
function handleClass(node, ctx) {
    const name = nameOf(node);
    if (!name)
        return;
    pushSymbol(ctx, node, name, 'class', undefined);
    extractHeritage(node, name, ctx);
    walkClassBody(node, name, ctx);
}
function handleInterface(node, ctx) {
    const name = nameOf(node);
    if (!name)
        return;
    pushSymbol(ctx, node, name, 'interface', undefined);
    const heritage = namedKids(node).find((c) => c.type === 'extends_type_clause');
    if (heritage) {
        for (const child of namedKids(heritage)) {
            ctx.refs.push({ fromSymbol: name, name: identifierRoot(child), kind: 'extends' });
        }
    }
}
function handleTypeAlias(node, ctx) {
    const name = nameOf(node);
    if (!name)
        return;
    pushSymbol(ctx, node, name, 'type', undefined);
}
function handleEnum(node, ctx) {
    const name = nameOf(node);
    if (!name)
        return;
    pushSymbol(ctx, node, name, 'enum', undefined);
}
function handleImport(node, ctx) {
    const source = node.childForFieldName('source');
    if (!source)
        return;
    const raw = source.text.replace(/^['"]|['"]$/g, '');
    ctx.imports.push({ raw });
}
function handleModuleLevelExpression(node, ctx) {
    walkExpressionForRefs(node, null, ctx);
}
function walkTopLevel(node, ctx) {
    for (const child of namedKids(node)) {
        walkNode(child, ctx);
    }
}
function unwrapExportStatement(node) {
    const decl = node.childForFieldName('declaration');
    return decl ?? node;
}
function walkNode(node, ctx) {
    switch (node.type) {
        case 'import_statement':
            handleImport(node, ctx);
            return;
        case 'export_statement': {
            const inner = unwrapExportStatement(node);
            if (inner !== node) {
                walkNode(inner, ctx);
            }
            else {
                handleModuleLevelExpression(node, ctx);
            }
            return;
        }
        case 'function_declaration':
        case 'generator_function_declaration':
            handleFunctionDeclaration(node, ctx);
            return;
        case 'class_declaration':
            handleClass(node, ctx);
            return;
        case 'interface_declaration':
            handleInterface(node, ctx);
            return;
        case 'type_alias_declaration':
            handleTypeAlias(node, ctx);
            return;
        case 'enum_declaration':
            handleEnum(node, ctx);
            return;
        case 'lexical_declaration':
        case 'variable_declaration':
            for (const declarator of namedKids(node)) {
                if (declarator.type === 'variable_declarator')
                    handleArrowConst(declarator, ctx);
            }
            return;
        case 'expression_statement':
            handleModuleLevelExpression(node, ctx);
            return;
        default:
            // Not a construct we extract symbols from; still scan for top-level call refs
            // in constructs like if/for bodies at module scope is out of scope for now.
            return;
    }
}
/** Extract symbols, refs, and imports from a parsed TS/TSX/JS syntax tree. */
export function extractTsJs(tree) {
    const ctx = { symbols: [], refs: [], imports: [] };
    try {
        walkTopLevel(tree.rootNode, ctx);
    }
    catch {
        return { symbols: [], refs: [], imports: [] };
    }
    return ctx;
}
