// Copyright (c) 2026 FairYan, Leeheisen
// Ported from funplay-godot-mcp (MIT, Copyright (c) 2026 FunplayAI).
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — live-game event history (funplay parity)
// ============================================================
// funplay keeps an in-game event ring buffer so an agent can ask "what changed
// in the last few seconds". yanhuifair's runtime bridge only answers "what is
// the state right now".
//
// This is implemented Node-side, by sampling the existing runtime bridge and
// diffing consecutive snapshots. That keeps the Godot-side runtime_bridge.gd
// untouched (no upstream merge risk) at the cost of only recording while the
// MCP server is the one asking.
// ============================================================

import { z } from 'zod';
import { ErrorCode } from '../../utils/errors.js';
import { ToolResult } from '../../utils/types.js';
import { sendGameCommand } from '../runtime_bridge.js';
import { fail, okJson } from './common.js';

interface RuntimeEvent {
  t: number;
  type: string;
  path?: string;
  detail?: string;
}

interface TreeEntry {
  name: string;
  type: string;
  path: string;
  depth: number;
  text?: string;
}

const MAX_BUFFER = 2000;

let _events: RuntimeEvent[] = [];
let _lastTree: Map<string, TreeEntry> | null = null;
let _lastRoot = '';
let _lastNodeCount = 0;
let _lastWatch = new Map<string, string>();
let _lastSampleAt = 0;
let _sampleCount = 0;

function record(event: RuntimeEvent): void {
  _events.push(event);
  if (_events.length > MAX_BUFFER) _events = _events.slice(_events.length - MAX_BUFFER);
}

function stableValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

async function takeSample(watchNode?: string): Promise<void> {
  const treeResult = await sendGameCommand('get_tree', {});
  const tree: TreeEntry[] = treeResult?.tree || [];
  const now = Date.now();

  const current = new Map<string, TreeEntry>();
  for (const entry of tree) current.set(entry.path, entry);

  if (_lastTree === null) {
    record({
      t: now,
      type: 'snapshot_initial',
      detail: `root=${treeResult?.root ?? '?'} nodes=${tree.length}`,
    });
  } else {
    for (const [path, entry] of current) {
      if (!_lastTree.has(path)) {
        record({ t: now, type: 'node_added', path, detail: entry.type });
      }
    }
    for (const [path, entry] of _lastTree) {
      if (!current.has(path)) {
        record({ t: now, type: 'node_removed', path, detail: entry.type });
      }
    }
    if ((treeResult?.root ?? '') !== _lastRoot) {
      record({ t: now, type: 'root_changed', detail: `${_lastRoot} -> ${treeResult?.root ?? '?'}` });
    }
  }

  if (watchNode) {
    try {
      const info = await sendGameCommand('get_node', { path: watchNode });
      const props: Record<string, unknown> = info?.properties || {};
      const currentWatch = new Map<string, string>();
      for (const [key, value] of Object.entries(props)) currentWatch.set(key, stableValue(value));
      if (_lastWatch.size > 0) {
        for (const [key, value] of currentWatch) {
          const previous = _lastWatch.get(key);
          if (previous !== undefined && previous !== value) {
            record({ t: now, type: 'property_changed', path: watchNode, detail: `${key}: ${previous} -> ${value}` });
          }
        }
        for (const [key] of _lastWatch) {
          if (!currentWatch.has(key)) {
            record({ t: now, type: 'property_removed', path: watchNode, detail: key });
          }
        }
      }
      _lastWatch = currentWatch;
    } catch {
      // Watching is best-effort; a missing node must not break the sample.
    }
  }

  _lastTree = current;
  _lastRoot = treeResult?.root ?? '';
  _lastNodeCount = tree.length;
  _lastSampleAt = now;
  _sampleCount++;
}

export const getRuntimeEventsSchema = {
  sample: z.boolean().optional().default(true).describe('Take a fresh sample before returning the buffer'),
  clear: z.boolean().optional().default(false).describe('Clear the buffer after returning it'),
  max_events: z.number().int().min(1).max(2000).optional().default(100).describe('How many recent events to return'),
  watch_node: z.string().optional().describe('Also diff this live node\'s properties between samples (e.g. "/root/Main/Player")'),
  event_type: z.string().optional().describe('Only return events of this type (node_added, node_removed, property_changed, ...)'),
};

export async function handleGetRuntimeEvents(
  _projectRoot: string,
  args: { sample?: boolean; clear?: boolean; max_events?: number; watch_node?: string; event_type?: string }
): Promise<ToolResult> {
  const sample = args.sample !== false;
  try {
    if (sample) {
      await takeSample(args.watch_node);
    }
  } catch (err: any) {
    return fail(
      ErrorCode.RUNTIME_NOT_REACHABLE,
      `get_runtime_events could not sample the running game: ${err.message}`,
      'Start the game from the editor with the godot_mcp_runtime autoload enabled.'
    );
  }

  const typeFilter = args.event_type;
  const filtered = typeFilter ? _events.filter((e) => e.type === typeFilter) : _events;
  const maxEvents = args.max_events ?? 100;
  const returned = filtered.slice(Math.max(0, filtered.length - maxEvents));

  const payload = {
    reachable: true,
    sampled: sample,
    sample_count: _sampleCount,
    last_sample_at: _lastSampleAt || null,
    snapshot: { root: _lastRoot, node_count: _lastNodeCount },
    buffered_event_count: _events.length,
    returned_event_count: returned.length,
    event_types: [...new Set(_events.map((e) => e.type))],
    events: returned.map((e) => ({ time: new Date(e.t).toISOString(), ...e })),
  };

  if (args.clear) {
    _events = [];
    _lastWatch = new Map();
  }
  return okJson(payload);
}
