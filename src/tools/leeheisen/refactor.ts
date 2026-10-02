// Copyright (c) 2026 Leeheisen
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — safe two-phase script refactor (funplay parity)
// ============================================================
// funplay's plan_script_refactor / apply_script_refactor pair: a dry-run that
// lists every affected file BEFORE anything is written, then an explicit apply
// that requires apply=true AND confirm=true. Pure text work, so it needs no
// Godot process — it fits yanhuifair's strongest suit (offline file editing).
// ============================================================

import { z } from 'zod';
import { ErrorCode } from '../../utils/errors.js';
import { ToolResult } from '../../utils/types.js';
import { resolveProjectPath, readTextFile, writeTextFile } from '../../utils/file_utils.js';
import {
  collectFiles,
  countOccurrences,
  escapeRegExp,
  extensionsForLanguage,
  fail,
  okJson,
  readOnlyRefusal,
  stripResPrefix,
} from './common.js';

const RESOURCE_EXTENSIONS = ['.tscn', '.tres', '.gdshader', '.gdshaderinc', '.cfg', '.json'];

export const planScriptRefactorSchema = {
  find: z.string().min(1).describe('Text to find across project files'),
  replace: z.string().optional().default('').describe('Replacement text (default: empty = delete)'),
  path: z.string().optional().default('').describe('Project-relative subdirectory to limit the scan (default: whole project)'),
  language: z.enum(['auto', 'gdscript', 'dotnet', 'csharp', 'mixed']).optional().default('auto')
    .describe('Which script languages to scan (auto = detect from the project)'),
  include_resources: z.boolean().optional().default(false)
    .describe('Also scan .tscn/.tres/.gdshader/.cfg/.json, not just scripts'),
  case_sensitive: z.boolean().optional().default(true).describe('Match case-sensitively'),
  token_boundaries: z.boolean().optional().default(false)
    .describe('Only match whole identifiers (word boundaries)'),
  max_preview_matches: z.number().int().min(0).max(50).optional().default(3)
    .describe('Preview lines to show per file'),
  include_internal: z.boolean().optional().default(false)
    .describe('Include addons/godot-mcp sources (off by default)'),
};

export const applyScriptRefactorSchema = {
  ...planScriptRefactorSchema,
  apply: z.boolean().optional().default(true).describe('Must be true to write changes'),
  confirm: z.boolean().optional().default(false).describe('Must be true to write changes'),
};

interface RefactorArgs {
  find: string;
  replace?: string;
  path?: string;
  language?: string;
  include_resources?: boolean;
  case_sensitive?: boolean;
  token_boundaries?: boolean;
  max_preview_matches?: number;
  include_internal?: boolean;
  apply?: boolean;
  confirm?: boolean;
}

interface FilePlan {
  path: string;
  match_count: number;
  previews: { line: number; column: number; before: string; after: string }[];
}

function replaceLiteral(
  content: string,
  find: string,
  replace: string,
  caseSensitive: boolean,
  tokenBoundaries: boolean
): string {
  if (tokenBoundaries || !caseSensitive) {
    const flags = caseSensitive ? 'g' : 'gi';
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(find)}(?![A-Za-z0-9_])`, flags);
    // Function replacer: keeps `$1`-style text in the replacement literal.
    return content.replace(re, () => replace);
  }
  return content.split(find).join(replace);
}

function planFile(
  projectRoot: string,
  relPath: string,
  find: string,
  replace: string,
  caseSensitive: boolean,
  tokenBoundaries: boolean,
  maxPreview: number
): FilePlan {
  const content = readTextFile(resolveProjectPath(projectRoot, relPath)).content;
  const total = countOccurrences(content, find, caseSensitive, tokenBoundaries);
  const previews: FilePlan['previews'] = [];
  if (total > 0 && maxPreview > 0) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && previews.length < maxPreview; i++) {
      const line = lines[i];
      let column: number;
      if (tokenBoundaries) {
        const re = new RegExp(
          `(?<![A-Za-z0-9_])${escapeRegExp(find)}(?![A-Za-z0-9_])`,
          caseSensitive ? '' : 'i'
        );
        const m = re.exec(line);
        column = m ? m.index : -1;
      } else {
        column = caseSensitive ? line.indexOf(find) : line.toLowerCase().indexOf(find.toLowerCase());
      }
      if (column < 0) continue;
      previews.push({
        line: i + 1,
        column: column + 1,
        before: line.trim().slice(0, 240),
        after: replaceLiteral(line, find, replace, caseSensitive, tokenBoundaries).trim().slice(0, 240),
      });
    }
  }
  return { path: relPath, match_count: total, previews };
}

function runRefactor(projectRoot: string, args: RefactorArgs, apply: boolean): ToolResult {
  const find = args.find;
  const replace = args.replace ?? '';
  if (!find) return fail(ErrorCode.INVALID_ARGUMENT, "'find' is required");
  if (find === replace) {
    return fail(ErrorCode.INVALID_ARGUMENT, "'find' and 'replace' are identical — nothing to do");
  }

  const extensions = extensionsForLanguage(args.language || 'auto', projectRoot);
  if (args.include_resources) extensions.push(...RESOURCE_EXTENSIONS);

  const files = collectFiles(
    projectRoot,
    extensions,
    stripResPrefix(args.path || ''),
    true,
    args.include_internal === true
  );

  const plans: FilePlan[] = [];
  for (const relPath of files) {
    let plan: FilePlan;
    try {
      plan = planFile(
        projectRoot,
        relPath,
        find,
        replace,
        args.case_sensitive !== false,
        args.token_boundaries === true,
        args.max_preview_matches ?? 3
      );
    } catch {
      continue; // unreadable/binary file — skip rather than abort the whole plan
    }
    if (plan.match_count > 0) plans.push(plan);
  }

  const totalMatches = plans.reduce((sum, p) => sum + p.match_count, 0);

  if (apply) {
    if (args.apply !== true || args.confirm !== true) {
      return fail(
        ErrorCode.INVALID_ARGUMENT,
        'apply_script_refactor requires both apply=true and confirm=true (run plan_script_refactor first and review the preview)'
      );
    }
    const refusal = readOnlyRefusal('apply_script_refactor');
    if (refusal) return refusal;

    const changed: { path: string; matches: number }[] = [];
    for (const plan of plans) {
      const abs = resolveProjectPath(projectRoot, plan.path);
      const original = readTextFile(abs).content;
      const updated = replaceLiteral(
        original,
        find,
        replace,
        args.case_sensitive !== false,
        args.token_boundaries === true
      );
      if (updated === original) continue;
      writeTextFile(abs, updated, true);
      changed.push({ path: plan.path, matches: plan.match_count });
    }

    return okJson({
      success: true,
      dry_run: false,
      operation: 'replace',
      find_text: find,
      replace_text: replace,
      language: args.language || 'auto',
      scanned_file_count: files.length,
      affected_file_count: plans.length,
      total_matches: totalMatches,
      changed_files: changed,
      backups: '.bak files were written next to every changed file',
    });
  }

  return okJson({
    success: true,
    dry_run: true,
    operation: 'replace',
    find_text: find,
    replace_text: replace,
    path: stripResPrefix(args.path || ''),
    language: args.language || 'auto',
    include_resources: args.include_resources === true,
    case_sensitive: args.case_sensitive !== false,
    token_boundaries: args.token_boundaries === true,
    scanned_file_count: files.length,
    affected_file_count: plans.length,
    total_matches: totalMatches,
    files: plans,
    apply_instruction:
      'Review this plan, then call apply_script_refactor with the same arguments plus apply=true and confirm=true.',
  });
}

export function handlePlanScriptRefactor(projectRoot: string, args: RefactorArgs): ToolResult {
  try {
    return runRefactor(projectRoot, args, false);
  } catch (err: any) {
    return fail(ErrorCode.INTERNAL_ERROR, `Error planning refactor: ${err.message}`);
  }
}

export function handleApplyScriptRefactor(projectRoot: string, args: RefactorArgs): ToolResult {
  try {
    return runRefactor(projectRoot, args, true);
  } catch (err: any) {
    return fail(ErrorCode.INTERNAL_ERROR, `Error applying refactor: ${err.message}`);
  }
}
