// Copyright (c) 2026 FairYan, Leeheisen
// Ported from funplay-godot-mcp (MIT, Copyright (c) 2026 FunplayAI).
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — shared helpers
// ============================================================
// Everything under src/tools/leeheisen/ is ADDITIVE. It registers extra tools
// ported from funplay-godot-mcp without editing yanhuifair's own tool files, so
// upstream merges stay cheap. The only upstream touch points are:
//   - src/server.ts          (one import + one call to registerLeeheisenTools)
//   - src/utils/registry.ts  (ported write tools appended to WRITE_TOOLS)
// ============================================================

import fs from 'node:fs';
import { ErrorCode, toolError } from '../../utils/errors.js';
import { ToolResult } from '../../utils/types.js';
import { findFilesByExtension, readTextFile, resolveProjectPath } from '../../utils/file_utils.js';
import { sendEditorCommand } from '../editor_bridge.js';

/** Extensions scanned by the project-wide / refactor tools. */
export const TEXT_EXTENSIONS = [
  '.gd', '.cs', '.tscn', '.tres', '.gdshader', '.gdshaderinc', '.cfg', '.json', '.txt', '.md',
];

export const SCRIPT_EXTENSIONS = ['.gd', '.cs'];

/** Sources that belong to the MCP plugin itself, never to the user's project. */
const INTERNAL_PREFIXES = ['addons/godot-mcp/'];

export function isInternalPath(relPath: string): boolean {
  const p = toPosix(relPath);
  return INTERNAL_PREFIXES.some((prefix) => p.startsWith(prefix));
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function okJson(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function okText(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(code: ErrorCode, message: string, detail?: string): ToolResult {
  return toolError(code, message, detail);
}

export function isReadOnlyMode(): boolean {
  return process.env.GODOT_MCP_READ_ONLY === 'true';
}

/**
 * Handler-level read-only guard. The registry also filters by WRITE_TOOLS, but
 * the ported tools keep their own check so a missed registry edit can never turn
 * into a write slipping through in --read-only mode.
 */
export function readOnlyRefusal(toolName: string): ToolResult | null {
  if (!isReadOnlyMode()) return null;
  return fail(
    ErrorCode.READ_ONLY,
    `Tool "${toolName}" is a write operation and is blocked in read-only mode`
  );
}

/** Project-relative file list (POSIX separators), internal plugin sources removed. */
export function collectFiles(
  projectRoot: string,
  extensions: string[],
  subPath = '',
  recursive = true,
  includeInternal = false
): string[] {
  const found = findFilesByExtension(projectRoot, extensions, subPath, recursive);
  return includeInternal ? found : found.filter((f) => !isInternalPath(f));
}

export function readProjectText(projectRoot: string, relPath: string): string {
  return readTextFile(resolveProjectPath(projectRoot, relPath)).content;
}

export function projectFileExists(projectRoot: string, relPath: string): boolean {
  try {
    return fs.existsSync(resolveProjectPath(projectRoot, relPath));
  } catch {
    return false;
  }
}

/** `res://scripts/x.gd` and `scripts/x.gd` both become `scripts/x.gd`. */
export function stripResPrefix(relPath: string): string {
  const p = toPosix(relPath).trim();
  return p.startsWith('res://') ? p.slice(6) : p.replace(/^\/+/, '');
}

/** Run a command against the live Godot editor (TCP 9876, spawn fallback). */
export function editorCall(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return sendEditorCommand(method, params);
}

/** Truthy-ish argument parsing that tolerates strings from MCP clients. */
export function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

/** Roughly reproduce Godot's "language mode" detection from files on disk. */
export function detectProjectLanguageMode(projectRoot: string): 'gdscript' | 'dotnet' | 'mixed' {
  const hasDotnetProject =
    collectFiles(projectRoot, ['.csproj', '.sln'], '', false).length > 0 ||
    collectFiles(projectRoot, ['.cs']).length > 0;
  const hasGdscript = collectFiles(projectRoot, ['.gd']).length > 0;
  if (hasDotnetProject && hasGdscript) return 'mixed';
  if (hasDotnetProject) return 'dotnet';
  return 'gdscript';
}

/** Extensions selected by a requested language filter. */
export function extensionsForLanguage(language: string, projectRoot: string): string[] {
  switch ((language || 'auto').toLowerCase()) {
    case 'gdscript':
      return ['.gd'];
    case 'dotnet':
    case 'csharp':
    case 'cs':
      return ['.cs'];
    case 'mixed':
      return SCRIPT_EXTENSIONS;
    default: {
      const mode = detectProjectLanguageMode(projectRoot);
      if (mode === 'gdscript') return ['.gd'];
      if (mode === 'dotnet') return ['.cs'];
      return SCRIPT_EXTENSIONS;
    }
  }
}

/** Escape a literal for use inside a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Count occurrences of `needle` (optionally token-bounded) in a haystack. */
export function countOccurrences(
  haystack: string,
  needle: string,
  caseSensitive: boolean,
  tokenBoundaries: boolean
): number {
  if (needle === '') return 0;
  if (!tokenBoundaries) {
    const h = caseSensitive ? haystack : haystack.toLowerCase();
    const n = caseSensitive ? needle : needle.toLowerCase();
    let count = 0;
    let idx = h.indexOf(n);
    while (idx !== -1) {
      count++;
      idx = h.indexOf(n, idx + n.length);
    }
    return count;
  }
  const flags = caseSensitive ? 'g' : 'gi';
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(needle)}(?![A-Za-z0-9_])`, flags);
  return (haystack.match(re) || []).length;
}
