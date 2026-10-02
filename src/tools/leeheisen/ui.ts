// Copyright (c) 2026 Leeheisen
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — Control/UI construction toolchain (funplay parity)
// ============================================================
// yanhuifair only has list_ui_nodes (read-only). Building UI with the generic
// add_node + set_node_properties pair is possible but anchors/offsets/growth are
// exactly the part of .tscn that is easy to get wrong, so these wrappers matter.
//
// Composed from the editor commands the plugin already exposes:
//   add_node / set_node_properties / connect_editor_signal / run_gdscript /
//   save_scene. plugin.gd is not modified.
// ============================================================

import { z } from 'zod';
import { ErrorCode, isEditorCommandFailure } from '../../utils/errors.js';
import { ToolResult } from '../../utils/types.js';
import { editorCall, fail, okJson, readOnlyRefusal, stripResPrefix } from './common.js';
import { addConnection, addExtResource, applySceneFileEdit, findSceneNode, getOpenScenePath, readScene, saveOpenScene } from './scene_files.js';

type PropMap = Record<string, string>;

function editorFailure(err: any, tool: string): ToolResult {
  return fail(
    isEditorCommandFailure(err) ? ErrorCode.EDITOR_COMMAND_FAILED : ErrorCode.EDITOR_NOT_REACHABLE,
    `${tool} failed: ${err.message}`
  );
}

async function addNode(
  parent: string,
  type: string,
  name: string,
  properties: PropMap,
  save: boolean
): Promise<any> {
  return editorCall('add_node', {
    type,
    name: name || '',
    parent: parent || '.',
    properties,
    save,
  });
}

async function setProperties(nodePath: string, properties: PropMap, save: boolean): Promise<any> {
  return editorCall('set_node_properties', { path: nodePath, properties, save });
}

/**
 * Assign a resource (texture) to a node property.
 *
 * A resource cannot be written through set_node_properties (its values are
 * strings), and the plugin's run_gdscript Expression cannot reach load() or
 * ResourceSaver, so this goes through the .tscn: register an ext_resource, point
 * the property at it, then ask the editor to reload.
 */
async function assignTextureResource(
  projectRoot: string,
  nodePath: string,
  property: string,
  texturePath: string
): Promise<{ scene: string | null; ext_id: string | null; editor_resynced: boolean }> {
  await saveOpenScene();
  const open = await getOpenScenePath();
  if (!open) throw new Error('No scene is open in the editor');
  const sceneRel = stripResPrefix(open);
  const { doc } = readScene(projectRoot, sceneRel);
  const located = findSceneNode(doc, nodePath);
  if (!located) throw new Error(`Node not found in ${sceneRel}: ${nodePath}`);

  const resPath = `res://${stripResPrefix(texturePath)}`;
  const ext = addExtResource(doc, 'Texture2D', resPath);
  located.node.properties[property] = `ExtResource("${ext.id}")`;
  const { editor_resynced } = await applySceneFileEdit(projectRoot, sceneRel, doc);
  return { scene: sceneRel, ext_id: ext.id, editor_resynced };
}

/** Godot Control.LayoutPreset → anchor_left/top/right/bottom. */
const ANCHOR_PRESETS: Record<string, [number, number, number, number]> = {
  top_left: [0, 0, 0, 0],
  top_right: [1, 0, 1, 0],
  bottom_left: [0, 1, 0, 1],
  bottom_right: [1, 1, 1, 1],
  center_left: [0, 0.5, 0, 0.5],
  center_top: [0.5, 0, 0.5, 0],
  center_right: [1, 0.5, 1, 0.5],
  center_bottom: [0.5, 1, 0.5, 1],
  center: [0.5, 0.5, 0.5, 0.5],
  left_wide: [0, 0, 0, 1],
  top_wide: [0, 0, 1, 0],
  right_wide: [1, 0, 1, 1],
  bottom_wide: [0, 1, 1, 1],
  vcenter_wide: [0, 0.5, 1, 0.5],
  hcenter_wide: [0.5, 0, 0.5, 1],
  full_rect: [0, 0, 1, 1],
};

const PRESET_ORDER = [
  'top_left', 'top_right', 'bottom_left', 'bottom_right',
  'center_left', 'center_top', 'center_right', 'center_bottom', 'center',
  'left_wide', 'top_wide', 'right_wide', 'bottom_wide', 'vcenter_wide', 'hcenter_wide', 'full_rect',
];

function resolvePreset(preset: string | number | undefined): { name: string; index: number; anchors: [number, number, number, number] } | null {
  if (preset === undefined || preset === '') return null;
  if (typeof preset === 'number' || /^\d+$/.test(String(preset))) {
    const index = Number(preset);
    const name = PRESET_ORDER[index];
    if (!name) return null;
    return { name, index, anchors: ANCHOR_PRESETS[name] };
  }
  const name = String(preset).toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, string> = {
    top_left: 'top_left', topleft: 'top_left',
    full: 'full_rect', full_rect: 'full_rect', fill: 'full_rect', stretch: 'full_rect',
  };
  const key = aliases[name] || name;
  const anchors = ANCHOR_PRESETS[key];
  if (!anchors) return null;
  return { name: key, index: PRESET_ORDER.indexOf(key), anchors };
}

function parseQuad(value: string): number[] | null {
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean).map(Number);
  return parts.length === 4 && parts.every((n) => Number.isFinite(n)) ? parts : null;
}

const saveField = {
  save: z.boolean().optional().default(true).describe('Save the scene after the change (default true)'),
};

// ---- create_* ----

export const createUiRootSchema = {
  parent_path: z.string().optional().default('.').describe('Parent node path (default: scene root)'),
  name: z.string().optional().default('UI').describe('Node name'),
  type: z.enum(['Control', 'CanvasLayer']).optional().default('Control').describe('UI root kind'),
  full_rect: z.boolean().optional().default(true).describe('For Control: stretch to the full rect (anchors_preset=15)'),
  properties: z.record(z.string()).optional().describe('Extra properties (Godot string form)'),
  ...saveField,
};

export async function handleCreateUiRoot(_root: string, args: any): Promise<ToolResult> {
  try {
    const type = args.type || 'Control';
    const props: PropMap = { ...(args.properties || {}) };
    if (type === 'Control' && args.full_rect !== false) {
      props['anchors_preset'] = '15';
      props['anchor_right'] = '1';
      props['anchor_bottom'] = '1';
      props['grow_horizontal'] = '2';
      props['grow_vertical'] = '2';
    }
    const r = await addNode(args.parent_path || '.', type, args.name || 'UI', props, args.save !== false);
    return okJson({ created: r?.path ?? null, type, properties_applied: r?.failed_properties ? undefined : Object.keys(props), failed_properties: r?.failed_properties ?? [] });
  } catch (err: any) {
    return editorFailure(err, 'create_ui_root');
  }
}

export const createControlSchema = {
  parent_path: z.string().optional().default('.').describe('Parent node path'),
  type: z.string().min(1).describe('Any Control subclass (Label, Button, Panel, HBoxContainer, ...)'),
  name: z.string().optional().describe('Node name (default: auto-generated)'),
  properties: z.record(z.string()).optional().describe('Properties in Godot string form'),
  ...saveField,
};

export async function handleCreateControl(_root: string, args: any): Promise<ToolResult> {
  try {
    const r = await addNode(args.parent_path || '.', args.type, args.name || '', args.properties || {}, args.save !== false);
    return okJson({ created: r?.path ?? null, type: args.type, failed_properties: r?.failed_properties ?? [] });
  } catch (err: any) {
    return editorFailure(err, 'create_control');
  }
}

function makeTextControlTool(defaultType: string, toolName: string) {
  return async (_root: string, args: any): Promise<ToolResult> => {
    try {
      const props: PropMap = { ...(args.properties || {}) };
      if (args.text !== undefined) props['text'] = String(args.text);
      const r = await addNode(args.parent_path || '.', args.type || defaultType, args.name || '', props, args.save !== false);
      return okJson({ created: r?.path ?? null, type: args.type || defaultType, text: args.text ?? null, failed_properties: r?.failed_properties ?? [] });
    } catch (err: any) {
      return editorFailure(err, toolName);
    }
  };
}

export const createLabelSchema = {
  parent_path: z.string().optional().default('.').describe('Parent node path'),
  text: z.string().optional().default('Label').describe('Label text'),
  name: z.string().optional().describe('Node name'),
  properties: z.record(z.string()).optional().describe('Extra properties'),
  ...saveField,
};
export const handleCreateLabel = makeTextControlTool('Label', 'create_label');

export const createButtonSchema = {
  parent_path: z.string().optional().default('.').describe('Parent node path'),
  text: z.string().optional().default('Button').describe('Button text'),
  name: z.string().optional().describe('Node name'),
  properties: z.record(z.string()).optional().describe('Extra properties'),
  ...saveField,
};
export const handleCreateButton = makeTextControlTool('Button', 'create_button');

export const createPanelSchema = {
  parent_path: z.string().optional().default('.').describe('Parent node path'),
  name: z.string().optional().describe('Node name'),
  size: z.string().optional().describe('Optional size as "x,y"'),
  properties: z.record(z.string()).optional().describe('Extra properties'),
  ...saveField,
};

export async function handleCreatePanel(_root: string, args: any): Promise<ToolResult> {
  try {
    const props: PropMap = { ...(args.properties || {}) };
    if (args.size) {
      const [w, h] = String(args.size).split(',').map((v) => Number(v.trim()));
      if (Number.isFinite(w)) props['size'] = `Vector2(${w}, ${Number.isFinite(h) ? h : w})`;
    }
    const r = await addNode(args.parent_path || '.', 'Panel', args.name || '', props, args.save !== false);
    return okJson({ created: r?.path ?? null, type: 'Panel', failed_properties: r?.failed_properties ?? [] });
  } catch (err: any) {
    return editorFailure(err, 'create_panel');
  }
}

const CONTAINER_TYPES = ['HBoxContainer', 'VBoxContainer', 'GridContainer', 'MarginContainer', 'CenterContainer', 'PanelContainer', 'ScrollContainer', 'TabContainer', 'HSplitContainer', 'VSplitContainer', 'FlowContainer', 'HFlowContainer', 'VFlowContainer'];

export const createContainerSchema = {
  parent_path: z.string().optional().default('.').describe('Parent node path'),
  type: z.string().optional().default('VBoxContainer').describe(`Container type (${CONTAINER_TYPES.join(', ')})`),
  name: z.string().optional().describe('Node name'),
  properties: z.record(z.string()).optional().describe('Extra properties'),
  ...saveField,
};

export async function handleCreateContainer(_root: string, args: any): Promise<ToolResult> {
  try {
    const type = args.type || 'VBoxContainer';
    if (!/Container$/.test(type)) {
      return fail(ErrorCode.INVALID_ARGUMENT, `"${type}" is not a Container type. Suggested: ${CONTAINER_TYPES.join(', ')}`);
    }
    const r = await addNode(args.parent_path || '.', type, args.name || '', args.properties || {}, args.save !== false);
    return okJson({ created: r?.path ?? null, type, failed_properties: r?.failed_properties ?? [] });
  } catch (err: any) {
    return editorFailure(err, 'create_container');
  }
}

export const createTextureRectSchema = {
  parent_path: z.string().optional().default('.').describe('Parent node path'),
  name: z.string().optional().describe('Node name'),
  texture_path: z.string().optional().describe('Project-relative texture path, e.g. "icon.svg"'),
  properties: z.record(z.string()).optional().describe('Extra properties'),
  stretch_mode: z.string().optional().describe('Optional stretch_mode (0-6)'),
  ...saveField,
};

export async function handleCreateTextureRect(projectRoot: string, args: any): Promise<ToolResult> {
  try {
    const props: PropMap = { ...(args.properties || {}) };
    if (args.stretch_mode !== undefined) props['stretch_mode'] = String(args.stretch_mode);
    const r = await addNode(args.parent_path || '.', 'TextureRect', args.name || '', props, false);
    const nodePath = r?.path || args.name;
    let texture: { scene: string | null; ext_id: string | null; editor_resynced: boolean } | null = null;
    if (args.texture_path && nodePath) {
      await editorCall('save_scene', {});
      texture = await assignTextureResource(projectRoot, String(nodePath).replace(/^\.\//, ''), 'texture', args.texture_path);
    } else if (args.save !== false) {
      await editorCall('save_scene', {});
    }
    return okJson({
      created: nodePath ?? null,
      type: 'TextureRect',
      texture: texture ? { path: args.texture_path, ext_resource_id: texture.ext_id, editor_resynced: texture.editor_resynced } : null,
      failed_properties: r?.failed_properties ?? [],
    });
  } catch (err: any) {
    return editorFailure(err, 'create_texture_rect');
  }
}

// ---- set_* ----

export const setControlLayoutSchema = {
  node_path: z.string().min(1).describe('Control node path'),
  preset: z.string().optional().describe('Layout preset name (full_rect, center, top_left, ...) or index 0-15'),
  anchors: z.string().optional().describe('Explicit anchors as "left,top,right,bottom" (0-1)'),
  offsets: z.string().optional().describe('Explicit offsets as "left,top,right,bottom" (pixels)'),
  position: z.string().optional().describe('Position as "x,y"'),
  size: z.string().optional().describe('Size as "x,y"'),
  grow_horizontal: z.string().optional().describe('Grow direction: begin | end | both'),
  grow_vertical: z.string().optional().describe('Grow direction: begin | end | both'),
  ...saveField,
};

const GROW: Record<string, string> = { begin: '0', end: '1', both: '2' };

export async function handleSetControlLayout(_root: string, args: any): Promise<ToolResult> {
  try {
    const props: PropMap = {};
    const applied: string[] = [];

    const preset = resolvePreset(args.preset);
    if (args.preset !== undefined && !preset) {
      return fail(ErrorCode.INVALID_ARGUMENT, `Unknown layout preset "${args.preset}". Use one of: ${PRESET_ORDER.join(', ')}, or 0-15.`);
    }
    if (preset) {
      props['anchors_preset'] = String(preset.index);
      const [l, t, r, b] = preset.anchors;
      props['anchor_left'] = String(l);
      props['anchor_top'] = String(t);
      props['anchor_right'] = String(r);
      props['anchor_bottom'] = String(b);
      applied.push(`preset=${preset.name}`);
    }

    if (args.anchors) {
      const quad = parseQuad(args.anchors);
      if (!quad) return fail(ErrorCode.INVALID_ARGUMENT, `anchors must be "left,top,right,bottom" (got "${args.anchors}")`);
      props['anchor_left'] = String(quad[0]);
      props['anchor_top'] = String(quad[1]);
      props['anchor_right'] = String(quad[2]);
      props['anchor_bottom'] = String(quad[3]);
      applied.push('anchors');
    }
    if (args.offsets) {
      const quad = parseQuad(args.offsets);
      if (!quad) return fail(ErrorCode.INVALID_ARGUMENT, `offsets must be "left,top,right,bottom" (got "${args.offsets}")`);
      props['offset_left'] = String(quad[0]);
      props['offset_top'] = String(quad[1]);
      props['offset_right'] = String(quad[2]);
      props['offset_bottom'] = String(quad[3]);
      applied.push('offsets');
    }
    if (args.position) {
      const [x, y] = String(args.position).split(',').map((v) => Number(v.trim()));
      if (!Number.isFinite(x)) return fail(ErrorCode.INVALID_ARGUMENT, `position must be "x,y" (got "${args.position}")`);
      props['position'] = `Vector2(${x}, ${Number.isFinite(y) ? y : 0})`;
      applied.push('position');
    }
    if (args.size) {
      const [w, h] = String(args.size).split(',').map((v) => Number(v.trim()));
      if (!Number.isFinite(w)) return fail(ErrorCode.INVALID_ARGUMENT, `size must be "x,y" (got "${args.size}")`);
      props['size'] = `Vector2(${w}, ${Number.isFinite(h) ? h : 0})`;
      applied.push('size');
    }
    if (args.grow_horizontal) {
      const v = GROW[String(args.grow_horizontal).toLowerCase()];
      if (v === undefined) return fail(ErrorCode.INVALID_ARGUMENT, 'grow_horizontal must be begin | end | both');
      props['grow_horizontal'] = v;
      applied.push('grow_horizontal');
    }
    if (args.grow_vertical) {
      const v = GROW[String(args.grow_vertical).toLowerCase()];
      if (v === undefined) return fail(ErrorCode.INVALID_ARGUMENT, 'grow_vertical must be begin | end | both');
      props['grow_vertical'] = v;
      applied.push('grow_vertical');
    }

    if (Object.keys(props).length === 0) {
      return fail(ErrorCode.INVALID_ARGUMENT, 'Nothing to set — pass preset / anchors / offsets / position / size / grow_*.');
    }

    const r = await setProperties(args.node_path, props, args.save !== false);
    return okJson({ node_path: args.node_path, applied, preset: preset?.name ?? null, failed_properties: r?.failed_properties ?? [] });
  } catch (err: any) {
    return editorFailure(err, 'set_control_layout');
  }
}

export const setControlSizeFlagsSchema = {
  node_path: z.string().min(1).describe('Control node path'),
  horizontal: z.string().optional().describe('fill | expand | expand_fill | shrink_center | shrink_end'),
  vertical: z.string().optional().describe('fill | expand | expand_fill | shrink_center | shrink_end'),
  ...saveField,
};

const SIZE_FLAGS: Record<string, string> = {
  fill: '1', expand: '2', expand_fill: '3', shrink_center: '4', shrink_end: '8',
};

export async function handleSetControlSizeFlags(_root: string, args: any): Promise<ToolResult> {
  try {
    const props: PropMap = {};
    if (args.horizontal) {
      const v = SIZE_FLAGS[String(args.horizontal).toLowerCase()];
      if (!v) return fail(ErrorCode.INVALID_ARGUMENT, `Unknown horizontal size flag "${args.horizontal}" (fill | expand | expand_fill | shrink_center | shrink_end)`);
      props['size_flags_horizontal'] = v;
    }
    if (args.vertical) {
      const v = SIZE_FLAGS[String(args.vertical).toLowerCase()];
      if (!v) return fail(ErrorCode.INVALID_ARGUMENT, `Unknown vertical size flag "${args.vertical}" (fill | expand | expand_fill | shrink_center | shrink_end)`);
      props['size_flags_vertical'] = v;
    }
    if (Object.keys(props).length === 0) {
      return fail(ErrorCode.INVALID_ARGUMENT, 'Pass horizontal and/or vertical size flags.');
    }
    const r = await setProperties(args.node_path, props, args.save !== false);
    return okJson({ node_path: args.node_path, applied: Object.keys(props), failed_properties: r?.failed_properties ?? [] });
  } catch (err: any) {
    return editorFailure(err, 'set_control_size_flags');
  }
}

export const setControlTextSchema = {
  node_path: z.string().min(1).describe('Control node path'),
  text: z.string().describe('Text to set'),
  property: z.string().optional().default('text').describe('Property name (text, placeholder_text, title, ...)'),
  ...saveField,
};

export async function handleSetControlText(_root: string, args: any): Promise<ToolResult> {
  try {
    const property = args.property || 'text';
    const r = await setProperties(args.node_path, { [property]: String(args.text) }, args.save !== false);
    return okJson({ node_path: args.node_path, property, text: args.text, failed_properties: r?.failed_properties ?? [] });
  } catch (err: any) {
    return editorFailure(err, 'set_control_text');
  }
}

export const setControlThemeOverrideSchema = {
  node_path: z.string().min(1).describe('Control node path'),
  overrides: z.record(z.string()).describe('Theme override properties, e.g. {"theme_override_font_sizes/font_size": "24"}'),
  ...saveField,
};

export async function handleSetControlThemeOverride(_root: string, args: any): Promise<ToolResult> {
  try {
    const overrides: PropMap = args.overrides || {};
    if (Object.keys(overrides).length === 0) {
      return fail(ErrorCode.INVALID_ARGUMENT, 'overrides must contain at least one theme_override_* property.');
    }
    const r = await setProperties(args.node_path, overrides, args.save !== false);
    return okJson({
      node_path: args.node_path,
      applied: r?.failed_properties ? Object.keys(overrides).filter((k) => !r.failed_properties.includes(k)) : Object.keys(overrides),
      failed_properties: r?.failed_properties ?? [],
    });
  } catch (err: any) {
    return editorFailure(err, 'set_control_theme_override');
  }
}

export const setControlTextureSchema = {
  node_path: z.string().min(1).describe('Control node path (TextureRect, Button, ...)'),
  texture_path: z.string().min(1).describe('Project-relative texture path, e.g. "icon.svg"'),
  property: z.string().optional().default('texture').describe('Texture property to assign'),
  ...saveField,
};

export async function handleSetControlTexture(projectRoot: string, args: any): Promise<ToolResult> {
  try {
    const property = args.property || 'texture';
    const result = await assignTextureResource(projectRoot, args.node_path, property, args.texture_path);
    return okJson({
      node_path: args.node_path,
      property,
      texture: `res://${stripResPrefix(args.texture_path)}`,
      scene: result.scene,
      ext_resource_id: result.ext_id,
      editor_resynced: result.editor_resynced,
    });
  } catch (err: any) {
    return editorFailure(err, 'set_control_texture');
  }
}

export const connectNodeSignalSchema = {
  from_node: z.string().min(1).describe('Source node path'),
  signal: z.string().min(1).describe('Signal name'),
  to_node: z.string().optional().default('.').describe('Target node path (default: scene root)'),
  method: z.string().min(1).describe('Target method name'),
  ...saveField,
};

export async function handleConnectNodeSignal(projectRoot: string, args: any): Promise<ToolResult> {
  try {
    const refusal = readOnlyRefusal('connect_node_signal');
    if (refusal) return refusal;

    // Written file-side on purpose: the plugin's editor `connect_editor_signal`
    // registers the connection in memory but never marks the scene dirty, so it
    // is silently dropped by the next save (verified on Godot 4.7.2).
    await saveOpenScene();
    const open = await getOpenScenePath();
    if (!open) {
      return fail(ErrorCode.EDITOR_COMMAND_FAILED, 'connect_node_signal failed: no scene is open in the editor');
    }
    const sceneRel = stripResPrefix(open);
    const from = String(args.from_node).replace(/^\.\//, '');
    const to = args.to_node ? String(args.to_node).replace(/^\.\//, '') : '.';

    const { doc } = readScene(projectRoot, sceneRel);
    const added = addConnection(doc, from, args.signal, to, String(args.method));
    const { editor_resynced } = await applySceneFileEdit(projectRoot, sceneRel, doc);

    return okJson({
      from,
      signal: args.signal,
      to,
      method: args.method,
      scene: sceneRel,
      added,
      already_present: !added,
      editor_resynced,
    });
  } catch (err: any) {
    return editorFailure(err, 'connect_node_signal');
  }
}
