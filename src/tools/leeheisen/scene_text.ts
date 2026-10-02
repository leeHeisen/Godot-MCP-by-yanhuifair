// Copyright (c) 2026 FairYan
// Ported from funplay-godot-mcp (MIT, Copyright (c) 2026 FunplayAI); Leeheisen port.
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — text-preserving .tscn editing
// ============================================================
// The shared `serializeScene()` rewrite is lossy for anything the parser does
// not model: instanced nodes come back as `type="" instance="ExtResource(...)"`
// (nested quotes → parse error), `[editable path=...]` sections and the
// `unique_id=` node attributes Godot 4.7 writes are dropped. Rewriting a scene
// through it therefore corrupts any scene that instances another scene.
//
// Everything here edits the raw .tscn text instead: node subtrees, resource
// blocks and connections are copied verbatim, so unknown syntax survives.
// The parsed document is only used for navigation (paths, ids, duplicates).
// ============================================================

import { GodotDocument, NodeDefinition } from '../../utils/types.js';
import { parseScene } from '../../parsers/scene_parser.js';
import { escapeRegExp } from './common.js';

// ---- node lookup (Godot root-relative paths: "." / "LeeUI" / "LeeUI/Box") ----

export interface LocatedNode {
  node: NodeDefinition;
  path: string;
  parentPath: string | undefined;
}

export function collectSceneNodes(doc: GodotDocument): LocatedNode[] {
  const out: LocatedNode[] = [];
  const walk = (nodes: NodeDefinition[], parentPath: string) => {
    for (const node of nodes) {
      const path = parentPath === '' ? '.' : parentPath === '.' ? node.name : `${parentPath}/${node.name}`;
      out.push({ node, path, parentPath: parentPath === '' ? undefined : parentPath });
      walk(node.children, path);
    }
  };
  walk(doc.nodes, '');
  return out;
}

export function findSceneNode(doc: GodotDocument, nodePath: string): LocatedNode | null {
  const wanted = (nodePath || '').trim().replace(/^\.\//, '');
  const nodes = collectSceneNodes(doc);
  if (wanted === '' || wanted === '.' || wanted === '/') return nodes[0] ?? null;
  return nodes.find((n) => n.path === wanted) ?? null;
}

// ---- raw-text sections ----

export interface SceneSection {
  /** `gd_scene`, `ext_resource`, `sub_resource`, `node`, `connection`, `editable`, ... */
  kind: string;
  /** Index of the `[...]` header line. */
  startLine: number;
  /** Exclusive end: the next section's header line, or the line count. */
  endLine: number;
  attrs: Record<string, string>;
}

/** Parse `key="value"` / `key=value` pairs out of a section header body. */
function parseHeaderAttrs(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_]\w*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    attrs[m[1]] = value;
  }
  return attrs;
}

/**
 * Split a .tscn into header-delimited sections without interpreting properties.
 * Multi-line string/bracket continuations are tracked so a `[` inside a value
 * never starts a section.
 */
export function scanSceneSections(content: string): SceneSection[] {
  const lines = content.split('\n');
  const sections: SceneSection[] = [];
  let current: SceneSection | null = null;
  let openString = false;
  let depth = 0;

  const flush = (endLine: number) => {
    if (current) {
      current.endLine = endLine;
      sections.push(current);
      current = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!openString && depth === 0) {
      const m = line.match(/^\s*\[([A-Za-z_]\w*)\s*(.*)]\s*$/);
      if (m) {
        flush(i);
        current = { kind: m[1], startLine: i, endLine: lines.length, attrs: parseHeaderAttrs(m[2]) };
        continue;
      }
    }
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (openString) {
        if (ch === '\\') c++;
        else if (ch === '"') openString = false;
      } else if (ch === '"') {
        openString = true;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  flush(lines.length);
  return sections;
}

// ---- node blocks ----

export interface NodeBlock {
  /** Root-relative node path, same convention as the editor tools. */
  path: string;
  section: SceneSection;
}

/**
 * Pair every `[node ...]` section with the parsed hierarchy. Godot writes node
 * blocks in depth-first order, which is exactly how the parser rebuilds them.
 */
export function indexNodeBlocks(content: string, doc: GodotDocument): NodeBlock[] {
  const nodeSections = scanSceneSections(content).filter((s) => s.kind === 'node');
  const out: NodeBlock[] = [];
  let i = 0;
  const walk = (nodes: NodeDefinition[], parentPath: string) => {
    for (const node of nodes) {
      const path = parentPath === '' ? '.' : parentPath === '.' ? node.name : `${parentPath}/${node.name}`;
      const section = nodeSections[i++];
      if (section) out.push({ path, section });
      walk(node.children, path);
    }
  };
  walk(doc.nodes, '');
  return out;
}

export function findNodeBlock(content: string, doc: GodotDocument, nodePath: string): NodeBlock | null {
  const wanted = (nodePath || '').trim().replace(/^\.\//, '');
  const blocks = indexNodeBlocks(content, doc);
  if (wanted === '' || wanted === '.') return blocks[0] ?? null;
  return blocks.find((b) => b.path === wanted) ?? null;
}

/** Set (or append) one property inside a node block. Returns the new file text. */
export function setNodePropertyInText(content: string, block: NodeBlock, key: string, value: string): string {
  const lines = content.split('\n');
  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let i = block.section.startLine + 1; i < block.section.endLine; i++) {
    if (keyRe.test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return lines.join('\n');
    }
  }
  let insertAt = block.section.endLine;
  while (insertAt > block.section.startLine + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, `${key} = ${value}`);
  return lines.join('\n');
}

// ---- resources & connections ----

export interface ExtResourceSpec {
  type: string;
  path: string;
  id: string;
  uid?: string;
}

/** Insert an `[ext_resource]` line after the last one (verbatim text edit). */
export function addExtResourceToText(content: string, ext: ExtResourceSpec): { text: string; added: boolean } {
  const sections = scanSceneSections(content);
  if (sections.some((s) => s.kind === 'ext_resource' && s.attrs.path === ext.path)) {
    return { text: content, added: false };
  }
  const line =
    `[ext_resource type="${ext.type}"` +
    (ext.uid ? ` uid="${ext.uid}"` : '') +
    ` path="${ext.path}" id="${ext.id}"]`;

  const lines = content.split('\n');
  const extSections = sections.filter((s) => s.kind === 'ext_resource');
  const anchor = extSections.length > 0 ? extSections[extSections.length - 1] : sections[0];
  let insertAt = anchor ? anchor.endLine : 0;
  while (insertAt > (anchor ? anchor.startLine + 1 : 0) && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, line);
  return { text: lines.join('\n'), added: true };
}

export interface ConnectionSpec {
  signal: string;
  from: string;
  to: string;
  method: string;
}

/** Append a `[connection]` line unless the exact same connection already exists. */
export function appendConnectionToText(content: string, conn: ConnectionSpec): { text: string; added: boolean } {
  const doc = parseScene(content);
  const exists = doc.connections.some(
    (c) => c.from === conn.from && c.signal === conn.signal && c.to === conn.to && c.method === conn.method
  );
  if (exists) return { text: content, added: false };

  const line = `[connection signal="${conn.signal}" from="${conn.from}" to="${conn.to}" method="${conn.method}"]`;
  const lines = content.split('\n');
  const connSections = scanSceneSections(content).filter((s) => s.kind === 'connection');
  let insertAt = lines.length;
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
  if (connSections.length > 0) {
    const last = connSections[connSections.length - 1];
    insertAt = last.endLine;
    while (insertAt > last.startLine + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  }
  lines.splice(insertAt, 0, line);
  return { text: lines.join('\n'), added: true };
}

// ---- subtree extraction (PackedScene from a node) ----

export interface ExtractedSceneText {
  text: string;
  rootPath: string;
  nodeCount: number;
  extResources: { type: string; path: string }[];
  subResourceCount: number;
  connectionCount: number;
}

/** `rootPath` → subtree path without the leading "./" (Godot's `[editable]` form). */
function relativeToRoot(fullPath: string, rootPath: string): string {
  if (rootPath === '.') return fullPath;
  return fullPath === rootPath ? '' : fullPath.slice(rootPath.length + 1);
}

/** Godot `parent=` value for a node that lives at `fullPath` inside the subtree. */
function parentWithinSubtree(fullPath: string, rootPath: string): string {
  const rel = relativeToRoot(fullPath, rootPath);
  const idx = rel.lastIndexOf('/');
  return idx === -1 ? '.' : rel.slice(0, idx);
}

/** Drop ` parent=`/` index=` from a node header and append the new parent. */
function rewriteNodeHeader(headerLine: string, parent: string | null): string {
  let line = headerLine.replace(/\s+parent=("[^"]*"|\S+)/, '').replace(/\s+index=\d+/, '');
  if (parent !== null) line = line.replace(/]\s*$/, ` parent="${parent}"]`);
  return line;
}

/**
 * Copy a node subtree into standalone .tscn text. Node blocks, resource blocks
 * and `[editable]` sections are copied verbatim (only `parent=`/paths are
 * rewritten), so instanced nodes and Godot 4.7 node metadata survive.
 */
export function extractSubtreeText(content: string, nodePath: string): ExtractedSceneText {
  const doc = parseScene(content);
  const located = findSceneNode(doc, nodePath);
  if (!located) throw new Error(`Node not found: ${nodePath}`);
  const rootPath = located.path;

  const lines = content.split('\n');
  const inSubtree = (p: string) => p === rootPath || (rootPath !== '.' && p.startsWith(`${rootPath}/`));

  const blocks = indexNodeBlocks(content, doc).filter((b) => inSubtree(b.path));
  const nodeTexts = blocks.map((b) => {
    const blockLines = lines.slice(b.section.startLine, b.section.endLine);
    while (blockLines.length > 0 && blockLines[blockLines.length - 1].trim() === '') blockLines.pop();
    blockLines[0] = rewriteNodeHeader(blockLines[0], b.path === rootPath ? null : parentWithinSubtree(b.path, rootPath));
    return blockLines.join('\n');
  });
  const subtreeText = nodeTexts.join('\n');

  const referencedExt = new Set([...subtreeText.matchAll(/ExtResource\("([^"]+)"\)/g)].map((m) => m[1]));
  const referencedSub = new Set([...subtreeText.matchAll(/SubResource\("([^"]+)"\)/g)].map((m) => m[1]));

  const sections = scanSceneSections(content);
  const sectionText = (s: SceneSection): string => lines.slice(s.startLine, s.endLine).join('\n').replace(/\s+$/, '');

  const extBlocks = sections
    .filter((s) => s.kind === 'ext_resource' && referencedExt.has(s.attrs.id))
    .map((s) => ({ line: sectionText(s), type: s.attrs.type ?? '', path: s.attrs.path ?? '' }));
  const subBlocks = sections
    .filter((s) => s.kind === 'sub_resource' && referencedSub.has(s.attrs.id))
    .map(sectionText);

  const connections = doc.connections
    .filter((c) => inSubtree(c.from) && inSubtree(c.to))
    .map((c) => {
      const from = relativeToRoot(c.from, rootPath);
      const to = c.to === rootPath ? '.' : relativeToRoot(c.to, rootPath);
      let line = `[connection signal="${c.signal}" from="${from}" to="${to}" method="${c.method}"`;
      if (c.flags !== undefined) line += ` flags=${c.flags}`;
      if (c.unbinds !== undefined) line += ` unbinds=${c.unbinds}`;
      return `${line}]`;
    });

  const editable = sections
    .filter((s) => s.kind === 'editable')
    .map((s) => {
      const rawPath = s.attrs.path;
      if (!rawPath || !inSubtree(rawPath)) return null;
      const rel = relativeToRoot(rawPath, rootPath);
      return rel === '' ? null : `[editable path="${rel}"]`;
    })
    .filter((line): line is string => line !== null);

  const resourceCount = extBlocks.length + subBlocks.length;
  const head = resourceCount > 0 ? `[gd_scene load_steps=${resourceCount + 1} format=3]` : '[gd_scene format=3]';
  const parts: string[] = [head];
  if (extBlocks.length > 0) parts.push(extBlocks.map((e) => e.line).join('\n'));
  if (subBlocks.length > 0) parts.push(subBlocks.join('\n'));
  parts.push(nodeTexts.join('\n\n'));
  if (connections.length > 0) parts.push(connections.join('\n'));
  if (editable.length > 0) parts.push(editable.join('\n'));

  return {
    text: `${parts.filter((p) => p.length > 0).join('\n\n')}\n`,
    rootPath,
    nodeCount: blocks.length,
    extResources: extBlocks.map((e) => ({ type: e.type, path: e.path })),
    subResourceCount: subBlocks.length,
    connectionCount: connections.length,
  };
}
