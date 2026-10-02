// Copyright (c) 2026 FairYan, Leeheisen
// Ported from funplay-godot-mcp (MIT, Copyright (c) 2026 FunplayAI).
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — editor assertions (funplay parity)
// ============================================================
// funplay ships assert_node_exists / assert_node_property /
// assert_signal_connected so an agent can close the loop on its own edits
// instead of eyeballing a diff. yanhuifair has no assertion tools at all.
//
// These are composed ENTIRELY from commands the existing plugin.gd already
// exposes (get_current_scene_tree / get_node_properties / list_node_signals /
// run_gdscript), so the plugin source stays untouched.
// ============================================================

import { z } from 'zod';
import { ErrorCode, isEditorCommandFailure } from '../../utils/errors.js';
import { ToolResult } from '../../utils/types.js';
import { editorCall, fail, stripResPrefix } from './common.js';
import { getOpenScenePath, readScene } from './scene_files.js';

function assertionResult(passed: boolean, payload: Record<string, unknown>): ToolResult {
  const text = JSON.stringify({ passed, ...payload }, null, 2);
  if (passed) return { content: [{ type: 'text', text }] };
  return { content: [{ type: 'text', text }], isError: true };
}

function normalizePath(p: string): string {
  const trimmed = (p || '').trim().replace(/\\/g, '/');
  if (trimmed === '' || trimmed === '.' || trimmed === '/') return '.';
  return trimmed.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

// ---- assert_node_exists ----

export const assertNodeExistsSchema = {
  node_path: z.string().optional().default('.').describe('Node path relative to the edited scene root ("." = root)'),
  should_exist: z.boolean().optional().default(true).describe('Set false to assert the node is absent'),
};

/** Rebuild absolute-ish node paths from the plugin's depth-tagged flat tree. */
function buildNodePaths(tree: { name: string; type: string; depth: number }[]): { path: string; type: string }[] {
  const out: { path: string; type: string }[] = [];
  const stack: string[] = [];
  for (const entry of tree) {
    stack.length = entry.depth;
    stack[entry.depth] = entry.name;
    // Godot node paths are root-relative: "." = root, "LeeUI" = direct child.
    const path = entry.depth === 0 ? '.' : stack.slice(1, entry.depth + 1).join('/');
    out.push({ path, type: entry.type });
  }
  return out;
}

export async function handleAssertNodeExists(
  _projectRoot: string,
  args: { node_path?: string; should_exist?: boolean }
): Promise<ToolResult> {
  const wanted = normalizePath(args.node_path || '.');
  const shouldExist = args.should_exist !== false;
  try {
    const treeResult = await editorCall('get_current_scene_tree', {});
    const tree: { name: string; type: string; depth: number }[] = treeResult?.tree || [];
    const nodes = buildNodePaths(tree);
    const rootName = tree.length > 0 ? tree[0].name : '';
    const match =
      wanted === '.'
        ? nodes[0]
        : nodes.find((n) => n.path === wanted || n.path === `./${wanted}`);
    const exists = !!match;
    const passed = exists === shouldExist;
    return assertionResult(passed, {
      assertion: 'assert_node_exists',
      scene: treeResult?.scene || null,
      node_path: wanted,
      should_exist: shouldExist,
      exists,
      matched_path: match?.path ?? null,
      node_type: match?.type ?? null,
      root_name: rootName,
      node_count: nodes.length,
      ...(passed ? {} : { message: shouldExist ? `Node "${wanted}" was not found in the edited scene` : `Node "${wanted}" exists but should not` }),
      available_paths_sample: passed ? undefined : nodes.slice(0, 40).map((n) => n.path),
    });
  } catch (err: any) {
    return fail(
      isEditorCommandFailure(err) ? ErrorCode.EDITOR_COMMAND_FAILED : ErrorCode.EDITOR_NOT_REACHABLE,
      `assert_node_exists failed: ${err.message}`
    );
  }
}

// ---- assert_node_property ----

export const assertNodePropertySchema = {
  node_path: z.string().min(1).describe('Node path relative to the edited scene root ("." = root)'),
  property: z.string().min(1).describe('Property name (use editor_get_node_properties to list them)'),
  expected: z.string().describe('Expected value in Godot string form (e.g. "Vector2(1, 2)", "42", "true", "Hello")'),
  tolerance: z.number().optional().describe('Numeric tolerance; floats compare with this slack'),
};

function normalizeComparable(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/,\s*/g, ',')
    .toLowerCase();
}

function extractNumbers(value: string): number[] {
  return [...value.matchAll(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi)].map((m) => Number(m[0]));
}

export async function handleAssertNodeProperty(
  _projectRoot: string,
  args: { node_path: string; property: string; expected: string; tolerance?: number }
): Promise<ToolResult> {
  const nodePath = normalizePath(args.node_path);
  try {
    const info = await editorCall('get_node_properties', { path: nodePath });
    const properties: Record<string, unknown> = info?.properties || {};
    if (!(args.property in properties)) {
      return assertionResult(false, {
        assertion: 'assert_node_property',
        node_path: nodePath,
        node_type: info?.type ?? null,
        property: args.property,
        expected: args.expected,
        found: false,
        message: `Property "${args.property}" does not exist on ${info?.type || 'node'}`,
        available_properties_sample: Object.keys(properties).slice(0, 60),
      });
    }

    const actual = properties[args.property];
    const actualText = normalizeComparable(actual);
    const expectedText = normalizeComparable(args.expected);

    let passed = actualText === expectedText;
    let mode = 'exact';
    if (!passed && args.tolerance !== undefined && args.tolerance > 0) {
      const a = extractNumbers(actualText);
      const b = extractNumbers(expectedText);
      if (a.length > 0 && a.length === b.length) {
        mode = 'numeric_tolerance';
        passed = a.every((n, i) => Math.abs(n - b[i]) <= args.tolerance!);
      }
    }

    return assertionResult(passed, {
      assertion: 'assert_node_property',
      node_path: nodePath,
      node_type: info?.type ?? null,
      property: args.property,
      expected: args.expected,
      actual,
      compare_mode: mode,
      tolerance: args.tolerance ?? null,
      ...(passed ? {} : { message: `Expected ${args.property} == "${args.expected}" but got "${String(actual)}"` }),
    });
  } catch (err: any) {
    return fail(
      isEditorCommandFailure(err) ? ErrorCode.EDITOR_COMMAND_FAILED : ErrorCode.EDITOR_NOT_REACHABLE,
      `assert_node_property failed: ${err.message}`
    );
  }
}

// ---- assert_signal_connected ----

export const assertSignalConnectedSchema = {
  from_node: z.string().min(1).describe('Signal source node path'),
  signal: z.string().min(1).describe('Signal name'),
  to_node: z.string().optional().describe('Target node path (default: scene root)'),
  method: z.string().optional().describe('Target callable/method name'),
  connected: z.boolean().optional().default(true).describe('Set false to assert the connection is absent'),
};

export async function handleAssertSignalConnected(
  projectRoot: string,
  args: { from_node: string; signal: string; to_node?: string; method?: string; connected?: boolean }
): Promise<ToolResult> {
  const fromNode = normalizePath(args.from_node);
  const toNode = args.to_node ? normalizePath(args.to_node) : '.';
  const shouldBeConnected = args.connected !== false;

  // Two sources of truth, because neither is sufficient alone:
  //  - the live editor tells us how many connections the signal has (but the
  //    plugin's connection dicts don't expose target/method on Godot 4);
  //  - the saved .tscn records exact from/to/method pairs.
  let liveConnections: number | null = null;
  let signalExists = true;
  let nodeType: string | null = null;
  try {
    const info = await editorCall('list_node_signals', { node: fromNode });
    nodeType = info?.type ?? null;
    const signals: { name: string; connections: number }[] = info?.signals || [];
    const entry = signals.find((s) => s.name === args.signal);
    if (!entry) {
      signalExists = false;
    } else {
      liveConnections = entry.connections;
    }
  } catch (err: any) {
    if (!isEditorCommandFailure(err)) {
      return fail(ErrorCode.EDITOR_NOT_REACHABLE, `assert_signal_connected failed: ${err.message}`);
    }
  }

  if (!signalExists) {
    return assertionResult(false, {
      assertion: 'assert_signal_connected',
      from_node: fromNode,
      node_type: nodeType,
      signal: args.signal,
      connected: false,
      checked_via: 'list_node_signals',
      message: `Node "${fromNode}" has no signal named "${args.signal}"`,
    });
  }

  let sceneRel: string | null = null;
  let fileMatches: { from: string; to: string; method: string }[] = [];
  try {
    const open = await getOpenScenePath();
    if (open) {
      sceneRel = stripResPrefix(open);
      const { doc } = readScene(projectRoot, sceneRel);
      fileMatches = doc.connections
        .filter((c) => c.signal === args.signal && c.from === fromNode)
        .map((c) => ({ from: c.from, to: c.to, method: c.method }));
    }
  } catch {
    sceneRel = null;
  }

  const exactMatch = fileMatches.find(
    (c) => (!args.to_node || c.to === toNode) && (!args.method || c.method === args.method)
  );

  const needsExact = Boolean(args.method || args.to_node);
  const isConnected = needsExact ? Boolean(exactMatch) : (liveConnections ?? 0) > 0;

  return assertionResult(isConnected === shouldBeConnected, {
    assertion: 'assert_signal_connected',
    from_node: fromNode,
    signal: args.signal,
    to_node: args.to_node ? toNode : null,
    method: args.method ?? null,
    connected: isConnected,
    live_connection_count: liveConnections,
    scene: sceneRel,
    scene_file_connections: fileMatches,
    checked_via: needsExact ? 'scene_file_connection_table' : 'list_node_signals',
    ...(isConnected === shouldBeConnected
      ? {}
      : {
          message: needsExact
            ? `No saved connection ${fromNode}.${args.signal} -> ${toNode}.${args.method ?? '<any>'} (live count: ${liveConnections ?? 'unknown'}). Save the scene first if the connection was just made.`
            : `Expected ${args.signal} connected=${shouldBeConnected}, found ${liveConnections ?? 0} connection(s)`,
        }),
  });
}
