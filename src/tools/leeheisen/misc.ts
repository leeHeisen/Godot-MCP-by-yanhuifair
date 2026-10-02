// Copyright (c) 2026 Leeheisen
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — patch_script, PackedScene extraction, project skills,
// performance snapshot (funplay parity)
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ErrorCode, isEditorCommandFailure } from '../../utils/errors.js';
import { ToolResult } from '../../utils/types.js';
import { resolveProjectPath, readTextFile, writeTextFile } from '../../utils/file_utils.js';
import { serializeScene } from '../../parsers/scene_parser.js';
import {
  detectProjectLanguageMode,
  editorCall,
  fail,
  okJson,
  okText,
  readOnlyRefusal,
  stripResPrefix,
} from './common.js';
import { extractSubtree, getOpenScenePath, readScene, saveOpenScene } from './scene_files.js';

function countNodesIn(node: { children?: unknown[] }): number {
  let total = 1;
  for (const child of (node.children || []) as { children?: unknown[] }[]) total += countNodesIn(child);
  return total;
}

// ---- patch_script ----

export const patchScriptSchema = {
  path: z.string().min(1).describe('Script file to patch (project-relative)'),
  find: z.string().optional().describe('Text to find'),
  replace: z.string().optional().default('').describe('Replacement text (default: delete the find text)'),
  replace_all: z.boolean().optional().default(true).describe('Replace every occurrence (false = only the first)'),
  case_sensitive: z.boolean().optional().default(true).describe('Case-sensitive matching'),
  prepend: z.string().optional().describe('Text to insert at the top of the file'),
  append: z.string().optional().describe('Text to append at the end of the file'),
  create_backup: z.boolean().optional().default(true).describe('Write a .bak backup before modifying'),
};

export function handlePatchScript(
  projectRoot: string,
  args: { path: string; find?: string; replace?: string; replace_all?: boolean; case_sensitive?: boolean; prepend?: string; append?: string; create_backup?: boolean }
): ToolResult {
  try {
    const refusal = readOnlyRefusal('patch_script');
    if (refusal) return refusal;

    const relPath = stripResPrefix(args.path);
    const abs = resolveProjectPath(projectRoot, relPath);
    if (!fs.existsSync(abs)) return fail(ErrorCode.FILE_NOT_FOUND, `File not found: ${relPath}`);

    let content = readTextFile(abs).content;
    const original = content;
    let replacements = 0;

    if (args.find !== undefined && args.find !== '') {
      const replacement = args.replace ?? '';
      const caseSensitive = args.case_sensitive !== false;
      if (args.replace_all !== false) {
        if (caseSensitive) {
          const parts = content.split(args.find);
          replacements = parts.length - 1;
          content = parts.join(replacement);
        } else {
          const re = new RegExp(args.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          content = content.replace(re, () => {
            replacements++;
            return replacement;
          });
        }
      } else {
        const index = caseSensitive
          ? content.indexOf(args.find)
          : content.toLowerCase().indexOf(args.find.toLowerCase());
        if (index >= 0) {
          content = content.slice(0, index) + replacement + content.slice(index + args.find.length);
          replacements = 1;
        }
      }
    }

    if (args.prepend) content = args.prepend + content;
    if (args.append) content = content + args.append;

    if (content === original) {
      return okJson({ changed: false, path: relPath, replacements, message: 'Nothing matched — file left untouched.' });
    }

    writeTextFile(abs, content, args.create_backup !== false);
    return okJson({
      changed: true,
      path: relPath,
      replacements,
      prepended: args.prepend !== undefined,
      appended: args.append !== undefined,
      bytes_before: Buffer.byteLength(original, 'utf-8'),
      bytes_after: Buffer.byteLength(content, 'utf-8'),
    });
  } catch (err: any) {
    return fail(ErrorCode.INTERNAL_ERROR, `Error patching script: ${err.message}`);
  }
}

// ---- create_packed_scene_from_node ----

export const createPackedSceneFromNodeSchema = {
  node_path: z.string().min(1).describe('Node in the edited scene to extract ("." = scene root)'),
  output_path: z.string().min(1).describe('Output .tscn path, project-relative (e.g. "scenes/ui/hud.tscn")'),
  scene_path: z.string().optional().describe('Source scene (default: the scene currently open in the editor)'),
  keep_owner: z.boolean().optional().default(true).describe('Keep existing child ownership when packing'),
};

export async function handleCreatePackedSceneFromNode(
  projectRoot: string,
  args: { node_path: string; output_path: string; scene_path?: string; keep_owner?: boolean }
): Promise<ToolResult> {
  try {
    const refusal = readOnlyRefusal('create_packed_scene_from_node');
    if (refusal) return refusal;

    let outputRel = stripResPrefix(args.output_path);
    if (!outputRel.toLowerCase().endsWith('.tscn')) outputRel += '.tscn';
    const nodePath = args.node_path.trim() || '.';

    // The plugin's run_gdscript Expression cannot reach ResourceSaver/PackedScene,
    // so the extraction is done on the .tscn itself — which also means it works
    // offline. Flush the editor state first so the file on disk is current.
    let sourceScene = args.scene_path ? stripResPrefix(args.scene_path) : '';
    if (!sourceScene) {
      await saveOpenScene();
      const open = await getOpenScenePath();
      if (!open) {
        return fail(ErrorCode.EDITOR_COMMAND_FAILED, 'No scene is open in the editor — pass scene_path explicitly.');
      }
      sourceScene = stripResPrefix(open);
    }

    const { doc } = readScene(projectRoot, sourceScene);
    const extracted = extractSubtree(doc, nodePath);
    const absOut = resolveProjectPath(projectRoot, outputRel);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    writeTextFile(absOut, serializeScene(extracted.doc), false);

    return okJson({
      created: outputRel,
      source_scene: sourceScene,
      source_node: nodePath,
      extracted_root: extracted.rootPath,
      node_count: countNodesIn(extracted.doc.nodes[0]),
      ext_resources: extracted.doc.extResources.map((e) => ({ type: e.type, path: e.path })),
      sub_resources: extracted.doc.subResources.length,
      connections: extracted.doc.connections.length,
    });
  } catch (err: any) {
    if (isEditorCommandFailure(err)) {
      return fail(ErrorCode.EDITOR_COMMAND_FAILED, `create_packed_scene_from_node failed: ${err.message}`);
    }
    return fail(ErrorCode.INTERNAL_ERROR, `create_packed_scene_from_node failed: ${err.message}`);
  }
}

// ---- generate_project_skills ----

export const generateProjectSkillsSchema = {
  output_dir: z.string().optional().default('.godot-mcp/skills').describe('Where to write skill files (project-relative)'),
  write_agents_md: z.boolean().optional().default(true).describe('Also create/append an AGENTS.md bridge block'),
  overwrite: z.boolean().optional().default(false).describe('Overwrite existing skill files'),
};

const AGENTS_MARKER_BEGIN = '<!-- godot-mcp:begin -->';
const AGENTS_MARKER_END = '<!-- godot-mcp:end -->';

function skillFiles(languageMode: string): { name: string; body: string }[] {
  const languageNote =
    languageMode === 'dotnet'
      ? 'This is a Godot **.NET / C#** project. Use `get_dotnet_project_info`, `create_csharp_script`, `validate_csharp_project` and `get_csharp_errors` for C# work, and `connect_node_signal` / `set_control_*` for UI.'
      : languageMode === 'mixed'
        ? 'This is a **mixed** Godot project (GDScript + C#). Pick the script tooling that matches the file you touch.'
        : 'This is a **GDScript** project.';

  return [
    {
      name: '00-overview.md',
      body: `# Godot MCP — project skills

Generated by the Leeheisen tool port. ${languageNote}

## Tool map

| Goal | Tools |
|---|---|
| Understand the project | \`map_project\`, \`generate_project_report\`, \`analyze_scene_complexity\` |
| Edit scenes/nodes | \`read_scene\`, \`add_node\`, \`modify_node\`, \`editor_*\` |
| Edit scripts | \`read_script\`, \`patch_script\`, \`write_script\`, \`plan_script_refactor\` |
| Build UI | \`create_ui_root\`, \`create_label\`, \`create_button\`, \`set_control_layout\`, \`connect_node_signal\` |
| Verify | \`assert_node_exists\`, \`assert_node_property\`, \`assert_signal_connected\` |
| Runtime debugging | \`runtime_get_tree\`, \`runtime_freeze\`, \`runtime_step\`, \`get_runtime_events\` |
| C# | \`get_dotnet_project_info\`, \`create_csharp_script\`, \`validate_csharp_project\`, \`get_csharp_errors\` |

## Working rules

1. Map before editing: run \`map_project\` so you know which scenes and scripts exist.
2. Preview before rewriting: use \`plan_script_refactor\`, then \`apply_script_refactor\` with \`confirm=true\`.
3. Close the loop: after a change, assert it with \`assert_node_exists\` / \`assert_node_property\`.
4. \`.cs\` files are not semantically analysed — validate them with \`validate_csharp_project\` (\`run_build=true\`).
`,
    },
    {
      name: '10-ui-workflow.md',
      body: `# UI workflow

1. \`create_ui_root\` — adds a Control (optionally full-rect) or CanvasLayer under the edited scene.
2. \`create_container\` — VBox/HBox/Grid/Margin/Center containers for layout.
3. \`create_label\` / \`create_button\` / \`create_texture_rect\` — leaves.
4. \`set_control_layout\` — anchors preset, offsets, position, size, grow direction.
5. \`set_control_size_flags\` — fill / expand / expand_fill.
6. \`connect_node_signal\` — wire \`pressed\` etc. to a method.
7. \`assert_node_exists\` / \`assert_signal_connected\` — verify.

Every editor mutation is registered on Godot's undo stack, so Ctrl+Z reverts it.
`,
    },
    {
      name: '20-runtime-debugging.md',
      body: `# Runtime debugging

The runtime bridge talks to the **running game** (autoload \`godot_mcp_runtime\`, TCP 9877).

- \`runtime_get_tree\` / \`runtime_get_node\` — inspect live state.
- \`runtime_freeze\` → \`runtime_step\` → \`runtime_screenshot\` — deterministic frame stepping.
- \`get_runtime_events\` — sampled history of node add/remove and property changes. Pass
  \`watch_node\` to diff one node's properties between samples.
`,
    },
  ];
}

export function handleGenerateProjectSkills(
  projectRoot: string,
  args: { output_dir?: string; write_agents_md?: boolean; overwrite?: boolean }
): ToolResult {
  try {
    const refusal = readOnlyRefusal('generate_project_skills');
    if (refusal) return refusal;

    const outDirRel = stripResPrefix(args.output_dir || '.godot-mcp/skills');
    const outDirAbs = resolveProjectPath(projectRoot, outDirRel);
    fs.mkdirSync(outDirAbs, { recursive: true });

    const languageMode = detectProjectLanguageMode(projectRoot);
    const written: string[] = [];
    const skipped: string[] = [];
    for (const file of skillFiles(languageMode)) {
      const abs = path.join(outDirAbs, file.name);
      if (fs.existsSync(abs) && args.overwrite !== true) {
        skipped.push(`${outDirRel}/${file.name}`);
        continue;
      }
      fs.writeFileSync(abs, file.body, 'utf-8');
      written.push(`${outDirRel}/${file.name}`);
    }

    let agentsUpdated = false;
    if (args.write_agents_md !== false) {
      const agentsAbs = resolveProjectPath(projectRoot, 'AGENTS.md');
      const block = `${AGENTS_MARKER_BEGIN}
## Godot MCP

This project is driven with the Godot MCP server. Project skills live in \`${outDirRel}/\`.

- Map the project first: \`map_project\`.
- Preview script rewrites with \`plan_script_refactor\`; apply with \`apply_script_refactor\` + \`confirm=true\`.
- Verify with \`assert_node_exists\` / \`assert_node_property\` / \`assert_signal_connected\`.
${languageMode === 'dotnet' || languageMode === 'mixed' ? '- C#: validate with `validate_csharp_project` (`run_build=true`); `.cs` files are not semantically analysed.\n' : ''}${AGENTS_MARKER_END}
`;
      const existing = fs.existsSync(agentsAbs) ? fs.readFileSync(agentsAbs, 'utf-8') : '';
      if (existing.includes(AGENTS_MARKER_BEGIN)) {
        const start = existing.indexOf(AGENTS_MARKER_BEGIN);
        const end = existing.indexOf(AGENTS_MARKER_END);
        if (end === -1) {
          fs.writeFileSync(agentsAbs, existing + '\n' + block, 'utf-8');
          agentsUpdated = true;
        } else {
          const updated = existing.slice(0, start) + block + existing.slice(end + AGENTS_MARKER_END.length + 1);
          if (updated !== existing) {
            fs.writeFileSync(agentsAbs, updated, 'utf-8');
            agentsUpdated = true;
          }
        }
      } else {
        const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
        fs.writeFileSync(agentsAbs, existing + separator + block, 'utf-8');
        agentsUpdated = true;
      }
    }

    return okJson({
      language_mode: languageMode,
      output_dir: outDirRel,
      written,
      skipped,
      agents_md_updated: agentsUpdated,
      note: 'Re-run with overwrite=true to refresh existing skill files.',
    });
  } catch (err: any) {
    return fail(ErrorCode.INTERNAL_ERROR, `Error generating project skills: ${err.message}`);
  }
}

// ---- get_performance_snapshot ----

export const getPerformanceSnapshotSchema = {};

export async function handleGetPerformanceSnapshot(_projectRoot: string): Promise<ToolResult> {
  try {
    const monitors = await editorCall('get_performance_monitors', {});
    let playing: unknown = null;
    try {
      playing = await editorCall('is_playing', {});
    } catch {
      playing = null;
    }
    return okJson({ playing, performance: monitors });
  } catch (err: any) {
    return fail(
      isEditorCommandFailure(err) ? ErrorCode.EDITOR_COMMAND_FAILED : ErrorCode.EDITOR_NOT_REACHABLE,
      `get_performance_snapshot failed: ${err.message}`
    );
  }
}

// Re-exported so register.ts has a single import surface.
export { okText };
