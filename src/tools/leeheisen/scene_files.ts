// Copyright (c) 2026 FairYan, Leeheisen
// Ported from funplay-godot-mcp (MIT, Copyright (c) 2026 FunplayAI).
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — .tscn file mutation helpers
// ============================================================
// The plugin's run_gdscript bridge evaluates a bare GDScript Expression with the
// scene root as its base instance, so global singletons (EditorInterface,
// ResourceSaver, load()) are NOT reachable from it. Rather than patch plugin.gd
// (upstream merge risk), the few tools that need resource-level work go through
// the .tscn on disk and ask the editor to reload.
//
// All writes are raw-text edits (see scene_text.ts). The shared serializeScene()
// round-trip is deliberately NOT used for writes: it mangles instanced nodes and
// drops `[editable]` / `unique_id` metadata.
// ============================================================

import fs from 'node:fs';
import { ExtResource, GodotDocument } from '../../utils/types.js';
import { resolveProjectPath, readTextFile, writeTextFile } from '../../utils/file_utils.js';
import { parseScene } from '../../parsers/scene_parser.js';
import { editorCall, stripResPrefix, toPosix } from './common.js';

export { collectSceneNodes, findSceneNode } from './scene_text.js';

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
 * Write already-edited scene text back to disk, then resync the editor.
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
  content: string
): Promise<{ editor_resynced: boolean; absPath: string }> {
  const rel = stripResPrefix(sceneRel);
  const absPath = resolveProjectPath(projectRoot, rel);
  writeTextFile(absPath, content, true);

  const openScene = await getOpenScenePath();
  const openRel = openScene ? stripResPrefix(openScene) : '';
  if (!openRel || toPosix(openRel) !== toPosix(rel)) {
    return { editor_resynced: false, absPath };
  }

  let closed: boolean;
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

/** True when a scene file exists on disk. */
export function sceneExists(projectRoot: string, sceneRel: string): boolean {
  try {
    return fs.existsSync(resolveProjectPath(projectRoot, stripResPrefix(sceneRel)));
  } catch {
    return false;
  }
}
