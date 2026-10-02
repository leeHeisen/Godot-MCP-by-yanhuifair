// Copyright (c) 2026 Leeheisen
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — .tscn file mutation helpers
// ============================================================
// The plugin's run_gdscript bridge evaluates a bare GDScript Expression with the
// scene root as its base instance, so global singletons (EditorInterface,
// ResourceSaver, load()) are NOT reachable from it. Rather than patch plugin.gd
// (upstream merge risk), the few tools that need resource-level work go through
// the .tscn on disk and ask the editor to reload.
// ============================================================

import fs from 'node:fs';
import { ExtResource, GodotDocument, NodeDefinition } from '../../utils/types.js';
import { resolveProjectPath, readTextFile, writeTextFile } from '../../utils/file_utils.js';
import { parseScene, serializeScene } from '../../parsers/scene_parser.js';
import { editorCall, stripResPrefix, toPosix } from './common.js';

/** Path of the scene currently open in the editor, as `res://...`, or null. */
export async function getOpenScenePath(): Promise<string | null> {
  try {
    const r = await editorCall('get_open_scene', {});
    const scene = r?.scene ?? r?.path ?? null;
    return scene ? String(scene) : null;
  } catch {
    return null;
  }
}

export function readScene(projectRoot: string, sceneRel: string): { doc: GodotDocument; absPath: string } {
  const rel = stripResPrefix(sceneRel);
  const absPath = resolveProjectPath(projectRoot, rel);
  return { doc: parseScene(readTextFile(absPath).content), absPath };
}

/**
 * Rewrite a scene file, then resync the editor.
 *
 * Two plugin behaviours force this shape (both verified against a live Godot
 * 4.7.2 editor, and neither is something the port is allowed to fix upstream):
 *   - `reload_scene` calls `EditorInterface.save_scene()` BEFORE reloading, so it
 *     writes the stale in-memory scene over our file edit and then reloads that.
 *   - `open_asset` on the already-open scene is a no-op, so it cannot reload.
 * Closing the scene and reopening it from the path is the one sequence that
 * actually picks the edited file up. Unsaved state is flushed first, so nothing
 * is lost — the cost is losing undo history for that scene.
 */
export async function applySceneFileEdit(
  projectRoot: string,
  sceneRel: string,
  doc: GodotDocument
): Promise<{ editor_resynced: boolean; absPath: string }> {
  const rel = stripResPrefix(sceneRel);
  const absPath = resolveProjectPath(projectRoot, rel);
  writeTextFile(absPath, serializeScene(doc), true);

  const openScene = await getOpenScenePath();
  const openRel = openScene ? stripResPrefix(openScene) : '';
  if (!openRel || toPosix(openRel) !== toPosix(rel)) {
    return { editor_resynced: false, absPath };
  }

  let closed = false;
  try {
    const r = await editorCall('close_scene', {});
    closed = r?.closed === true;
  } catch {
    closed = false;
  }
  if (!closed) return { editor_resynced: false, absPath };

  try {
    await editorCall('open_asset', { path: `res://${rel}` });
    return { editor_resynced: true, absPath };
  } catch {
    return { editor_resynced: false, absPath };
  }
}

/** Make sure the editor has flushed its in-memory scene to disk. */
export async function saveOpenScene(): Promise<void> {
  try {
    await editorCall('save_scene', {});
  } catch {
    // No open scene / no unsaved state — nothing to flush.
  }
}

// ---- node lookup ----

export interface LocatedNode {
  node: NodeDefinition;
  path: string;
  parentPath: string | undefined;
}

/**
 * Walk the scene hierarchy collecting Godot-style root-relative paths, i.e. the
 * exact convention the editor tools use: "." for the root, "LeeUI" for a direct
 * child, "LeeUI/LeeBox" for a grandchild. (The .tscn `parent=` / `from=` fields
 * use the same convention, which is what makes file lookups line up.)
 */
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

// ---- extension resources ----

export function allocateExtResourceId(doc: GodotDocument): string {
  const used = new Set(doc.extResources.map((e) => e.id));
  used.add('0');
  let n = doc.extResources.length + 1;
  let id = `${n}_lee`;
  while (used.has(id)) {
    n++;
    id = `${n}_lee`;
  }
  return id;
}

export function findExtResourceByPath(doc: GodotDocument, resPath: string): ExtResource | undefined {
  return doc.extResources.find((e) => e.path === resPath);
}

export function addExtResource(doc: GodotDocument, type: string, resPath: string): ExtResource {
  const existing = findExtResourceByPath(doc, resPath);
  if (existing) return existing;
  const ext: ExtResource = { type, path: resPath, id: allocateExtResourceId(doc) };
  doc.extResources.push(ext);
  return ext;
}

// ---- subtree extraction ----

function propertyTextOf(node: NodeDefinition): string {
  const parts: string[] = [node.instance ?? ''];
  for (const value of Object.values(node.properties)) parts.push(String(value));
  return parts.join('\n');
}

/**
 * Build a new scene containing only `nodePath` and its descendants, keeping
 * just the ext/sub resources the subtree actually references.
 */
export function extractSubtree(doc: GodotDocument, nodePath: string): { doc: GodotDocument; rootPath: string } {
  const located = findSceneNode(doc, nodePath);
  if (!located) throw new Error(`Node not found: ${nodePath}`);
  const rootPath = located.path;

  const subtreeText: string[] = [];
  const collect = (node: NodeDefinition) => {
    subtreeText.push(propertyTextOf(node));
    for (const child of node.children) collect(child);
  };
  collect(located.node);
  const text = subtreeText.join('\n');

  const extIds = new Set([...text.matchAll(/ExtResource\("([^"]+)"\)/g)].map((m) => m[1]));
  const subIds = new Set([...text.matchAll(/SubResource\("([^"]+)"\)/g)].map((m) => m[1]));

  const rewritePath = (p: string): string | null => {
    if (p === rootPath) return '.';
    if (rootPath === '.') return p;
    if (p.startsWith(`${rootPath}/`)) return p.slice(rootPath.length + 1);
    return null;
  };

  const connections = doc.connections
    .map((c) => {
      const from = rewritePath(c.from);
      const to = rewritePath(c.to);
      if (from === null || to === null) return null;
      return { ...c, from, to };
    })
    .filter((c): c is GodotDocument['connections'][number] => c !== null);

  // The extracted root keeps its children but loses its position among siblings.
  const rootClone: NodeDefinition = { ...located.node, index: undefined };

  return {
    rootPath,
    doc: {
      header: { format: doc.header.format ?? 3, uid: '', load_steps: undefined },
      extResources: doc.extResources.filter((e) => extIds.has(e.id)),
      subResources: doc.subResources.filter((s) => subIds.has(s.id)),
      nodes: [rootClone],
      connections,
    },
  };
}

/** True when a scene file exists on disk. */
export function sceneExists(projectRoot: string, sceneRel: string): boolean {
  try {
    return fs.existsSync(resolveProjectPath(projectRoot, stripResPrefix(sceneRel)));
  } catch {
    return false;
  }
}

/**
 * Append a `[connection]` entry, returning false when an identical one already
 * exists. Written file-side because the plugin's editor-based connect never
 * marks the scene dirty, so the connection is lost on the next save/reopen.
 */
export function addConnection(
  doc: GodotDocument,
  from: string,
  signal: string,
  to: string,
  method: string
): boolean {
  const exists = doc.connections.some(
    (c) => c.from === from && c.signal === signal && c.to === to && c.method === method
  );
  if (exists) return false;
  doc.connections.push({ signal, from, to, method });
  return true;
}
