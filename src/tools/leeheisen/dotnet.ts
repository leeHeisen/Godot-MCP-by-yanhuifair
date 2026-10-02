// Copyright (c) 2026 Leeheisen
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — Godot .NET / C# tooling (funplay parity)
// ============================================================
// yanhuifair reads and writes .cs as plain text and has no C# validation at
// all. funplay does three things right that are ported here:
//   1. get_dotnet_project_info  — .csproj/.sln + C# script inventory
//   2. create_csharp_script     — real C# template (PascalCase from the file
//                                 name, `partial`, namespace, [Tool], using System)
//   3. validate_csharp_project / get_csharp_errors — shell out to `dotnet build`
//      and surface the compiler diagnostics
// All of it is Node-side: no Godot process and no plugin changes required.
// ============================================================

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { z } from 'zod';
import { ErrorCode } from '../../utils/errors.js';
import { ToolResult } from '../../utils/types.js';
import { resolveProjectPath, readTextFile, writeTextFile } from '../../utils/file_utils.js';
import { collectFiles, fail, okJson, readOnlyRefusal, stripResPrefix } from './common.js';

// ---- Shared helpers ----

interface DotnetRun {
  ok: boolean;
  exitCode: number;
  output: string[];
  missing: boolean;
}

function runDotnet(args: string[], cwd: string, timeoutMs: number): Promise<DotnetRun> {
  return new Promise((resolve) => {
    execFile(
      'dotnet',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err: any, stdout: string, stderr: string) => {
        const output = `${stdout || ''}${stderr || ''}`
          .split(/\r?\n/)
          .map((l) => l.trimEnd())
          .filter((l) => l.length > 0);
        if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
          resolve({ ok: false, exitCode: -1, output, missing: true });
          return;
        }
        resolve({ ok: !err, exitCode: typeof err?.code === 'number' ? err.code : err ? 1 : 0, output, missing: false });
      }
    );
  });
}

function findDotnetProjectFiles(projectRoot: string): { csproj: string[]; sln: string[] } {
  let csproj = collectFiles(projectRoot, ['.csproj'], '', false);
  let sln = collectFiles(projectRoot, ['.sln'], '', false);
  if (csproj.length === 0 && sln.length === 0) {
    // Fall back to a recursive scan for solutions kept in a subdirectory.
    csproj = collectFiles(projectRoot, ['.csproj']);
    sln = collectFiles(projectRoot, ['.sln']);
  }
  return { csproj, sln };
}

function readTargetFramework(projectRoot: string, csprojRel: string): string {
  try {
    const content = readTextFile(resolveProjectPath(projectRoot, csprojRel)).content;
    const m = content.match(/<TargetFramework[s]?>([^<]+)</);
    return m ? m[1].trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readAssemblyName(projectRoot: string, csprojRel: string): string {
  try {
    const content = readTextFile(resolveProjectPath(projectRoot, csprojRel)).content;
    const m =
      content.match(/<AssemblyName>([^<]+)<\/AssemblyName>/) ||
      content.match(/<RootNamespace>([^<]+)<\/RootNamespace>/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function pascalCase(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return 'Script';
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

// ---- get_dotnet_project_info ----

export const getDotnetProjectInfoSchema = {};

export function handleGetDotnetProjectInfo(projectRoot: string): ToolResult {
  try {
    const { csproj, sln } = findDotnetProjectFiles(projectRoot);
    const csharpScripts = collectFiles(projectRoot, ['.cs']);

    if (csproj.length === 0 && sln.length === 0 && csharpScripts.length === 0) {
      return okJson({
        is_dotnet_project: false,
        note: 'No .csproj/.sln and no .cs files found — this project does not use C#/.NET.',
        project_root: projectRoot,
      });
    }

    return okJson({
      is_dotnet_project: true,
      project_root: projectRoot,
      csproj_files: csproj.map((f) => ({ path: f, target_framework: readTargetFramework(projectRoot, f), assembly_name: readAssemblyName(projectRoot, f) })),
      sln_files: sln,
      has_csproj: csproj.length > 0,
      has_sln: sln.length > 0,
      csharp_script_count: csharpScripts.length,
      csharp_scripts_preview: csharpScripts.slice(0, 50),
    });
  } catch (err: any) {
    return fail(ErrorCode.INTERNAL_ERROR, `Error reading .NET project info: ${err.message}`);
  }
}

// ---- create_csharp_script ----

export const createCsharpScriptSchema = {
  path: z.string().min(1).describe('Output path, must end with .cs (e.g. "scripts/Player.cs")'),
  class_name: z.string().optional().describe('C# class name (default: PascalCase of the file name)'),
  namespace: z.string().optional().describe('Optional file-scoped namespace'),
  extends: z.string().optional().default('Node').describe('Base class (e.g. Node2D, CharacterBody2D, Resource)'),
  body: z.string().optional().describe('Class body members; default is an empty _Ready()'),
  tool: z.boolean().optional().default(false).describe('Add the [Tool] attribute'),
  partial: z.boolean().optional().default(true).describe('Emit `partial class` (required by Godot)'),
  include_system: z.boolean().optional().default(false).describe('Always add `using System;`'),
};

export function handleCreateCsharpScript(
  projectRoot: string,
  args: { path: string; class_name?: string; namespace?: string; extends?: string; body?: string; tool?: boolean; partial?: boolean; include_system?: boolean }
): ToolResult {
  try {
    const refusal = readOnlyRefusal('create_csharp_script');
    if (refusal) return refusal;

    const relPath = stripResPrefix(args.path);
    if (!relPath.toLowerCase().endsWith('.cs')) {
      return fail(ErrorCode.INVALID_ARGUMENT, `C# script path must end with .cs (got "${args.path}")`);
    }

    const fileName = relPath.split('/').pop() || 'Script.cs';
    const className = (args.class_name || '').trim() || pascalCase(fileName.replace(/\.cs$/i, ''));
    const baseClass = (args.extends || 'Node').trim() || 'Node';
    const body = (args.body || '').trim();
    const usePartial = args.partial !== false;

    const lines: string[] = ['using Godot;'];
    if (args.include_system || /System\.|Console\./.test(body)) lines.push('using System;');
    lines.push('');
    const namespace = (args.namespace || '').trim();
    if (namespace) {
      lines.push(`namespace ${namespace};`, '');
    }
    if (args.tool) lines.push('[Tool]');
    lines.push(`public${usePartial ? ' partial' : ''} class ${className} : ${baseClass}`, '{');
    if (body) {
      for (const line of body.split('\n')) lines.push(line.length > 0 ? `\t${line}` : '');
    } else {
      lines.push('\tpublic override void _Ready()', '\t{', '\t}');
    }
    lines.push('}');

    const content = lines.join('\n') + '\n';
    const abs = resolveProjectPath(projectRoot, relPath);
    const existed = fs.existsSync(abs);
    writeTextFile(abs, content, false);

    return okJson({
      created: !existed,
      overwritten: existed,
      path: relPath,
      class_name: className,
      extends: baseClass,
      bytes_written: Buffer.byteLength(content, 'utf-8'),
      note: 'Godot .NET SDK-style projects include all .cs files automatically — no .csproj edit needed.',
    });
  } catch (err: any) {
    return fail(ErrorCode.INTERNAL_ERROR, `Error creating C# script: ${err.message}`);
  }
}

// ---- validate_csharp_project / get_csharp_errors ----

export const validateCsharpProjectSchema = {
  target: z.string().optional().describe('Project-relative .csproj/.sln to build (default: every discovered one)'),
  configuration: z.string().optional().default('Debug').describe('Build configuration (Debug/Release)'),
  run_build: z.boolean().optional().default(false).describe('Actually run `dotnet build` (default: only probe the SDK)'),
  timeout_ms: z.number().int().min(1000).max(600000).optional().default(240000).describe('Build timeout'),
};

export const getCsharpErrorsSchema = {
  target: z.string().optional().describe('Project-relative .csproj/.sln to build'),
  configuration: z.string().optional().default('Debug').describe('Build configuration'),
  timeout_ms: z.number().int().min(1000).max(600000).optional().default(240000).describe('Build timeout'),
};

interface CsharpValidationArgs {
  target?: string;
  configuration?: string;
  run_build?: boolean;
  timeout_ms?: number;
}

async function validateCsharp(projectRoot: string, args: CsharpValidationArgs) {
  const { csproj, sln } = findDotnetProjectFiles(projectRoot);
  const configuration = (args.configuration || 'Debug').trim() || 'Debug';
  const timeoutMs = args.timeout_ms ?? 240000;

  const probe = await runDotnet(['--version'], projectRoot, 30000);
  const dotnetAvailable = !probe.missing;

  const result: Record<string, unknown> = {
    project_root: projectRoot,
    has_csproj: csproj.length > 0,
    has_sln: sln.length > 0,
    csproj_files: csproj,
    sln_files: sln,
    dotnet_available: dotnetAvailable,
    dotnet_version: dotnetAvailable ? (probe.output[0] || '').trim() : null,
    configuration,
    build_attempted: false,
    build_ok: false,
    exit_code: -1,
    output: [] as string[],
  };

  if (!dotnetAvailable) {
    result['hint'] = 'The `dotnet` CLI was not found on PATH. Install the .NET SDK to validate C# projects.';
    return result;
  }

  if (args.run_build !== true) {
    result['output'] = probe.output;
    result['hint'] = 'Pass run_build=true to execute `dotnet build`.';
    return result;
  }

  const targetRel = args.target ? stripResPrefix(args.target) : csproj[0] || sln[0] || '';
  const buildArgs = ['build'];
  if (targetRel) buildArgs.push(resolveProjectPath(projectRoot, targetRel));
  buildArgs.push('-c', configuration, '--nologo');

  const build = await runDotnet(buildArgs, projectRoot, timeoutMs);
  result['build_attempted'] = true;
  result['build_ok'] = build.ok && build.exitCode === 0;
  result['exit_code'] = build.exitCode;
  result['target'] = targetRel || null;
  result['output'] = build.output;
  return result;
}

/** Compiler diagnostics only — the shape an AI client can act on directly. */
function extractErrors(output: string[]): string[] {
  return output.filter((line) => {
    const lower = line.toLowerCase();
    return (
      /:\s*error\s+[A-Z]{2,}\d+/i.test(line) ||
      lower.includes(': error cs') ||
      lower.startsWith('error ') ||
      /\berror\s+CS\d+/.test(line)
    );
  });
}

export async function handleValidateCsharpProject(projectRoot: string, args: CsharpValidationArgs): Promise<ToolResult> {
  try {
    return okJson(await validateCsharp(projectRoot, args));
  } catch (err: any) {
    return fail(ErrorCode.INTERNAL_ERROR, `Error validating C# project: ${err.message}`);
  }
}

export async function handleGetCsharpErrors(projectRoot: string, args: CsharpValidationArgs): Promise<ToolResult> {
  try {
    const validation = await validateCsharp(projectRoot, { ...args, run_build: true });
    const output = (validation['output'] as string[]) || [];
    const errors = extractErrors(output);
    return okJson({
      build_ok: validation['build_ok'],
      exit_code: validation['exit_code'],
      dotnet_available: validation['dotnet_available'],
      target: validation['target'] ?? null,
      configuration: validation['configuration'],
      error_count: errors.length,
      errors,
      output_tail: output.slice(-40),
    });
  } catch (err: any) {
    return fail(ErrorCode.INTERNAL_ERROR, `Error collecting C# errors: ${err.message}`);
  }
}
