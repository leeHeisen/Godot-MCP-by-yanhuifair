// Copyright (c) 2026 FairYan, Leeheisen
// Ported from funplay-godot-mcp (MIT, Copyright (c) 2026 FunplayAI).
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — project map + scene complexity (funplay parity)
// ============================================================
// funplay's map_project builds a graph of scenes, scripts, dependencies,
// signals and call edges, and can emit self-contained HTML. yanhuifair only has
// scene_dependency_graph (scenes -> scenes). This implementation reuses the
// existing .tscn parser, so it works with no Godot process running.
// ============================================================

import { z } from 'zod';
import { ErrorCode } from '../../utils/errors.js';
import { ToolResult } from '../../utils/types.js';
import { resolveProjectPath, readTextFile, writeTextFile } from '../../utils/file_utils.js';
import { parseScene } from '../../parsers/scene_parser.js';
import { collectFiles, fail, extensionsForLanguage, okJson, readOnlyRefusal, stripResPrefix } from './common.js';

// ---- script symbol extraction ----

interface ScriptSymbols {
  class_name: string;
  extends: string;
  functions: string[];
  signals: string[];
  exports: string[];
  dependencies: string[];
}

function extractGdScript(content: string): ScriptSymbols {
  const out: ScriptSymbols = { class_name: '', extends: '', functions: [], signals: [], exports: [], dependencies: [] };
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!out.class_name && line.startsWith('class_name ')) out.class_name = line.slice(11).trim().split(/\s/)[0];
    if (!out.extends && line.startsWith('extends ')) out.extends = line.slice(8).trim().split(/\s/)[0];
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(?:static\s+)?func\s+([A-Za-z_]\w*)/))) out.functions.push(m[1]);
    if ((m = line.match(/^signal\s+([A-Za-z_]\w*)/))) out.signals.push(m[1]);
    if ((m = line.match(/^@export\w*[^\n]*?\bvar\s+([A-Za-z_]\w*)/))) out.exports.push(m[1]);
    for (const d of line.matchAll(/(?:preload|load)\(\s*"([^"]+)"\s*\)/g)) out.dependencies.push(d[1]);
  }
  return out;
}

function extractCSharp(content: string): ScriptSymbols {
  const out: ScriptSymbols = { class_name: '', extends: '', functions: [], signals: [], exports: [], dependencies: [] };
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if (!out.class_name && (m = line.match(/\bclass\s+([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_][\w.]*))?/))) {
      out.class_name = m[1];
      if (m[2]) out.extends = m[2];
    }
    if ((m = line.match(/^(?:public|private|protected|internal)\s+(?:static\s+|virtual\s+|override\s+|async\s+|sealed\s+)*[\w<>[\].,?]+\s+([A-Za-z_]\w*)\s*\(/))) {
      out.functions.push(m[1]);
    }
    if ((m = line.match(/^\s*(?:public|private|protected|internal)\s+[\w<>[\].,?]+\s+([A-Za-z_]\w*)\s*\{\s*get;/))) {
      out.exports.push(m[1]);
    }
  }
  // [Export] on its own line, property on the next meaningful line.
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('[Export')) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const m = lines[j].match(/\b([A-Za-z_]\w*)\s*\{/);
      if (m) {
        out.exports.push(m[1]);
        break;
      }
    }
  }
  return out;
}

// ---- map_project ----

export const mapProjectSchema = {
  path: z.string().optional().default('').describe('Project-relative subdirectory to map (default: whole project)'),
  format: z.enum(['json', 'html']).optional().default('json').describe('Output format'),
  output_path: z.string().optional().describe('Write the map to this project-relative file instead of returning it'),
  include_addons: z.boolean().optional().default(false).describe('Include addons/ inside the map'),
  max_scripts: z.number().int().min(1).max(5000).optional().default(1000).describe('Cap on scripts analysed'),
};

interface MapEdge {
  from: string;
  to: string;
  kind: string;
}

function buildProjectMap(projectRoot: string, args: { path?: string; include_addons?: boolean; max_scripts?: number }) {
  const subPath = stripResPrefix(args.path || '');
  const includeInternal = args.include_addons === true;
  const maxScripts = args.max_scripts ?? 1000;

  const sceneFiles = collectFiles(projectRoot, ['.tscn'], subPath, true, includeInternal);
  const scriptFiles = collectFiles(projectRoot, extensionsForLanguage('mixed', projectRoot), subPath, true, includeInternal);

  const edges: MapEdge[] = [];
  const scenes = sceneFiles.map((rel) => {
    const content = readTextFile(resolveProjectPath(projectRoot, rel)).content;
    let doc;
    try {
      doc = parseScene(content);
    } catch {
      return { path: rel, error: 'parse failed' };
    }
    let nodeCount = 0;
    let maxDepth = 0;
    const walk = (nodes: any[], depth: number) => {
      for (const n of nodes) {
        nodeCount++;
        if (depth > maxDepth) maxDepth = depth;
        walk(n.children || [], depth + 1);
      }
    };
    walk(doc.nodes, 0);

    const scripts: string[] = [];
    const resources: string[] = [];
    for (const ext of doc.extResources) {
      const target = ext.path?.replace(/^res:\/\//, '') || '';
      if (!target) continue;
      if (ext.type === 'Script') {
        scripts.push(target);
        edges.push({ from: rel, to: target, kind: 'scene_script' });
      } else {
        resources.push(target);
        edges.push({ from: rel, to: target, kind: 'scene_resource' });
      }
    }
    const root = doc.nodes[0];
    return {
      path: rel,
      root_name: root?.name ?? '',
      root_type: root?.type ?? '',
      node_count: nodeCount,
      max_depth: maxDepth,
      scripts,
      resources,
      connection_count: doc.connections.length,
      connections: doc.connections.map((c) => ({ from: c.from, to: c.to, signal: c.signal, method: c.method })),
    };
  });

  const scripts = scriptFiles.slice(0, maxScripts).map((rel) => {
    const content = readTextFile(resolveProjectPath(projectRoot, rel)).content;
    const symbols = rel.toLowerCase().endsWith('.cs') ? extractCSharp(content) : extractGdScript(content);
    for (const dep of symbols.dependencies) {
      edges.push({ from: rel, to: dep.replace(/^res:\/\//, ''), kind: 'script_dependency' });
    }
    return { path: rel, language: rel.toLowerCase().endsWith('.cs') ? 'dotnet' : 'gdscript', ...symbols };
  });

  return {
    project_root: projectRoot,
    summary: {
      scene_count: scenes.length,
      script_count: scripts.length,
      gdscript_count: scripts.filter((s) => s.language === 'gdscript').length,
      csharp_count: scripts.filter((s) => s.language === 'dotnet').length,
      node_count: scenes.reduce((n, s: any) => n + (s.node_count || 0), 0),
      connection_count: scenes.reduce((n, s: any) => n + (s.connection_count || 0), 0),
      edge_count: edges.length,
    },
    scenes,
    scripts,
    edges,
  };
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderProjectMapHtml(mapData: ReturnType<typeof buildProjectMap>): string {
  const edgeCountByKind = new Map<string, number>();
  for (const e of mapData.edges) edgeCountByKind.set(e.kind, (edgeCountByKind.get(e.kind) || 0) + 1);

  const sceneRows = mapData.scenes
    .map((s: any) => `<tr><td>${escapeHtml(s.path)}</td><td>${escapeHtml(s.root_type || '')}</td><td>${s.node_count ?? 0}</td><td>${s.connection_count ?? 0}</td><td>${(s.scripts || []).length}</td></tr>`)
    .join('\n');
  const scriptRows = mapData.scripts
    .map((s: any) => `<tr><td>${escapeHtml(s.path)}</td><td>${escapeHtml(s.language)}</td><td>${escapeHtml(s.class_name || '')}</td><td>${escapeHtml(s.extends || '')}</td><td>${s.functions.length}</td></tr>`)
    .join('\n');
  const edgeRows = mapData.edges
    .slice(0, 2000)
    .map((e) => `<tr><td>${escapeHtml(e.from)}</td><td>${escapeHtml(e.kind)}</td><td>${escapeHtml(e.to)}</td></tr>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Project map</title>
<style>
body{font-family:system-ui,Segoe UI,sans-serif;margin:24px;color:#1f2933}
h1{font-size:22px}h2{font-size:16px;margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #d8e0e8;padding:4px 8px;text-align:left}
th{background:#eef3f8}.stats{display:flex;gap:18px;flex-wrap:wrap}
.stat{background:#f4f7fb;border:1px solid #d8e0e8;border-radius:6px;padding:8px 14px}
code{font-family:ui-monospace,Consolas,monospace}
</style></head><body>
<h1>Godot project map</h1>
<div class="stats">
<div class="stat"><b>${mapData.summary.scene_count}</b><br>scenes</div>
<div class="stat"><b>${mapData.summary.script_count}</b><br>scripts</div>
<div class="stat"><b>${mapData.summary.node_count}</b><br>nodes</div>
<div class="stat"><b>${mapData.summary.connection_count}</b><br>connections</div>
<div class="stat"><b>${mapData.summary.edge_count}</b><br>edges</div>
</div>
<h2>Scenes</h2><table><tr><th>path</th><th>root</th><th>nodes</th><th>connections</th><th>scripts</th></tr>${sceneRows}</table>
<h2>Scripts</h2><table><tr><th>path</th><th>language</th><th>class</th><th>extends</th><th>functions</th></tr>${scriptRows}</table>
<h2>Edges</h2><table><tr><th>from</th><th>kind</th><th>to</th></tr>${edgeRows}</table>
<p>Edge kinds: ${[...edgeCountByKind.entries()].map(([k, v]) => `<code>${escapeHtml(k)}=${v}</code>`).join(' ')}</p>
</body></html>`;
}

export function handleMapProject(
  projectRoot: string,
  args: { path?: string; format?: string; output_path?: string; include_addons?: boolean; max_scripts?: number }
): ToolResult {
  try {
    const mapData = buildProjectMap(projectRoot, args);
    const format = (args.format || 'json').toLowerCase();
    const outputPath = stripResPrefix(args.output_path || '');
    if (outputPath) {
      // map_project itself is read-only, but writing the map file is not.
      const refusal = readOnlyRefusal('map_project');
      if (refusal) return refusal;
    }

    if (format === 'html') {
      const html = renderProjectMapHtml(mapData);
      if (outputPath) {
        writeTextFile(resolveProjectPath(projectRoot, outputPath), html, false);
        return okJson({ written: outputPath, bytes: Buffer.byteLength(html, 'utf-8'), summary: mapData.summary });
      }
      return { content: [{ type: 'text', text: html }] };
    }

    if (outputPath) {
      const json = JSON.stringify(mapData, null, 2);
      writeTextFile(resolveProjectPath(projectRoot, outputPath), json, false);
      return okJson({ written: outputPath, bytes: Buffer.byteLength(json, 'utf-8'), summary: mapData.summary });
    }
    return okJson(mapData);
  } catch (err: any) {
    return fail(ErrorCode.INTERNAL_ERROR, `Error building project map: ${err.message}`);
  }
}

// ---- analyze_scene_complexity ----

export const analyzeSceneComplexitySchema = {
  scene_path: z.string().optional().describe('Specific .tscn to analyse (default: every scene)'),
  top_types: z.number().int().min(1).max(50).optional().default(12).describe('How many node types to report per scene'),
};

function analyseSceneFile(projectRoot: string, rel: string, topTypes: number) {
  const doc = parseScene(readTextFile(resolveProjectPath(projectRoot, rel)).content);
  const histogram = new Map<string, number>();
  let nodeCount = 0;
  let maxDepth = 0;
  let totalChildren = 0;
  const walk = (nodes: any[], depth: number) => {
    for (const n of nodes) {
      nodeCount++;
      if (depth > maxDepth) maxDepth = depth;
      histogram.set(n.type, (histogram.get(n.type) || 0) + 1);
      const children = n.children || [];
      totalChildren += children.length;
      walk(children, depth + 1);
    }
  };
  walk(doc.nodes, 0);

  const distinctTypes = histogram.size;
  const connectionCount = doc.connections.length;
  const scriptCount = doc.extResources.filter((e) => e.type === 'Script').length;
  // Weighted heuristic: structure depth and wiring cost more than raw node count.
  const complexityScore = Math.round(
    nodeCount + connectionCount * 2 + maxDepth * 3 + distinctTypes * 0.5 + scriptCount * 1.5
  );
  const rating = complexityScore < 40 ? 'low' : complexityScore < 120 ? 'moderate' : complexityScore < 300 ? 'high' : 'very_high';

  return {
    path: rel,
    node_count: nodeCount,
    max_depth: maxDepth,
    distinct_node_types: distinctTypes,
    script_count: scriptCount,
    connection_count: connectionCount,
    ext_resource_count: doc.extResources.length,
    sub_resource_count: doc.subResources.length,
    average_children: nodeCount > 0 ? Number((totalChildren / nodeCount).toFixed(2)) : 0,
    complexity_score: complexityScore,
    rating,
    top_types: [...histogram.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topTypes)
      .map(([type, count]) => ({ type, count })),
  };
}

export function handleAnalyzeSceneComplexity(
  projectRoot: string,
  args: { scene_path?: string; top_types?: number }
): ToolResult {
  try {
    const topTypes = args.top_types ?? 12;
    const targets = args.scene_path
      ? [stripResPrefix(args.scene_path)]
      : collectFiles(projectRoot, ['.tscn']);

    if (targets.length === 0) {
      return okJson({ scenes: [], note: 'No .tscn scenes found.' });
    }

    const scenes = targets.map((rel) => {
      try {
        return analyseSceneFile(projectRoot, rel, topTypes);
      } catch (err: any) {
        return { path: rel, error: `parse failed: ${err.message}` };
      }
    });

    return okJson({
      scene_count: scenes.length,
      total_nodes: scenes.reduce((n, s: any) => n + (s.node_count || 0), 0),
      most_complex: scenes
        .filter((s: any) => !s.error)
        .sort((a: any, b: any) => b.complexity_score - a.complexity_score)
        .slice(0, 5)
        .map((s: any) => ({ path: s.path, complexity_score: s.complexity_score, rating: s.rating })),
      scenes,
    });
  } catch (err: any) {
    return fail(ErrorCode.INTERNAL_ERROR, `Error analysing scene complexity: ${err.message}`);
  }
}
