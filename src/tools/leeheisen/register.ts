// Copyright (c) 2026 Leeheisen
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// Leeheisen port — tool registration
// ============================================================
// Single entry point for every ported tool, so upstream wiring only needs one
// extra call (see src/server.ts).
// ============================================================

import { ToolRegistry } from '../../utils/registry.js';
import {
  applyScriptRefactorSchema,
  handleApplyScriptRefactor,
  handlePlanScriptRefactor,
  planScriptRefactorSchema,
} from './refactor.js';
import {
  analyzeSceneComplexitySchema,
  handleAnalyzeSceneComplexity,
  handleMapProject,
  mapProjectSchema,
} from './project_map.js';
import {
  assertNodeExistsSchema,
  assertNodePropertySchema,
  assertSignalConnectedSchema,
  handleAssertNodeExists,
  handleAssertNodeProperty,
  handleAssertSignalConnected,
} from './assertions.js';
import {
  connectNodeSignalSchema,
  createButtonSchema,
  createContainerSchema,
  createControlSchema,
  createLabelSchema,
  createPanelSchema,
  createTextureRectSchema,
  createUiRootSchema,
  handleConnectNodeSignal,
  handleCreateButton,
  handleCreateContainer,
  handleCreateControl,
  handleCreateLabel,
  handleCreatePanel,
  handleCreateTextureRect,
  handleCreateUiRoot,
  handleSetControlLayout,
  handleSetControlSizeFlags,
  handleSetControlText,
  handleSetControlTexture,
  handleSetControlThemeOverride,
  setControlLayoutSchema,
  setControlSizeFlagsSchema,
  setControlTextSchema,
  setControlTextureSchema,
  setControlThemeOverrideSchema,
} from './ui.js';
import { getRuntimeEventsSchema, handleGetRuntimeEvents } from './runtime_events.js';
import {
  createCsharpScriptSchema,
  getCsharpErrorsSchema,
  getDotnetProjectInfoSchema,
  handleCreateCsharpScript,
  handleGetCsharpErrors,
  handleGetDotnetProjectInfo,
  handleValidateCsharpProject,
  validateCsharpProjectSchema,
} from './dotnet.js';
import {
  createPackedSceneFromNodeSchema,
  generateProjectSkillsSchema,
  getPerformanceSnapshotSchema,
  handleCreatePackedSceneFromNode,
  handleGenerateProjectSkills,
  handleGetPerformanceSnapshot,
  handlePatchScript,
  patchScriptSchema,
} from './misc.js';

export function registerLeeheisenTools(registry: ToolRegistry): void {
  // ---- Refactor (2) ----
  registry.setCategory('Leeheisen: Refactor');
  registry.register({
    name: 'plan_script_refactor',
    description: 'Dry-run a text refactor across project scripts/resources. Returns every affected file with line previews before anything is written.',
    schema: planScriptRefactorSchema,
    handler: (root, args) => handlePlanScriptRefactor(root, args),
  });
  registry.register({
    name: 'apply_script_refactor',
    description: 'Apply a refactor previously previewed by plan_script_refactor. Requires apply=true AND confirm=true; writes .bak backups.',
    schema: applyScriptRefactorSchema,
    handler: (root, args) => handleApplyScriptRefactor(root, args),
  });

  // ---- Project map (2) ----
  registry.setCategory('Leeheisen: Project Map');
  registry.register({
    name: 'map_project',
    description: 'Whole-project map: scenes, scripts, dependencies, signals and edges, as JSON or self-contained HTML. Works without Godot running.',
    schema: mapProjectSchema,
    handler: (root, args) => handleMapProject(root, args),
  });
  registry.register({
    name: 'analyze_scene_complexity',
    description: 'Score .tscn scenes by node count, depth, node-type spread and signal wiring; flags the most complex scenes.',
    schema: analyzeSceneComplexitySchema,
    handler: (root, args) => handleAnalyzeSceneComplexity(root, args),
  });

  // ---- Editor assertions (3) ----
  registry.setCategory('Leeheisen: Assertions');
  registry.register({
    name: 'assert_node_exists',
    description: 'Assert that a node exists (or does not exist) in the currently edited scene. Returns isError when the assertion fails.',
    schema: assertNodeExistsSchema,
    handler: (root, args) => handleAssertNodeExists(root, args),
  });
  registry.register({
    name: 'assert_node_property',
    description: 'Assert a node property equals an expected value (exact string compare, or numeric with tolerance). Returns isError on failure.',
    schema: assertNodePropertySchema,
    handler: (root, args) => handleAssertNodeProperty(root, args),
  });
  registry.register({
    name: 'assert_signal_connected',
    description: 'Assert a signal is connected to a target node/method (or assert that it is not). Returns isError on failure.',
    schema: assertSignalConnectedSchema,
    handler: (root, args) => handleAssertSignalConnected(root, args),
  });

  // ---- UI construction (13) ----
  registry.setCategory('Leeheisen: UI');
  registry.register({
    name: 'create_ui_root',
    description: 'Create a UI root (Control or CanvasLayer) in the edited scene; Control defaults to full-rect anchors.',
    schema: createUiRootSchema,
    handler: (root, args) => handleCreateUiRoot(root, args),
  });
  registry.register({
    name: 'create_control',
    description: 'Create any Control subclass node (Label, Button, Panel, HBoxContainer, ...) under a parent.',
    schema: createControlSchema,
    handler: (root, args) => handleCreateControl(root, args),
  });
  registry.register({
    name: 'create_label',
    description: 'Create a Label control with text.',
    schema: createLabelSchema,
    handler: (root, args) => handleCreateLabel(root, args),
  });
  registry.register({
    name: 'create_button',
    description: 'Create a Button control with text.',
    schema: createButtonSchema,
    handler: (root, args) => handleCreateButton(root, args),
  });
  registry.register({
    name: 'create_panel',
    description: 'Create a Panel control, optionally with an explicit size.',
    schema: createPanelSchema,
    handler: (root, args) => handleCreatePanel(root, args),
  });
  registry.register({
    name: 'create_container',
    description: 'Create a Container control (VBox/HBox/Grid/Margin/Center/Scroll/Panel/Tab/Split/Flow).',
    schema: createContainerSchema,
    handler: (root, args) => handleCreateContainer(root, args),
  });
  registry.register({
    name: 'create_texture_rect',
    description: 'Create a TextureRect and optionally assign a texture from a project path.',
    schema: createTextureRectSchema,
    handler: (root, args) => handleCreateTextureRect(root, args),
  });
  registry.register({
    name: 'set_control_layout',
    description: 'Set Control layout: anchors preset, explicit anchors/offsets, position, size and grow direction.',
    schema: setControlLayoutSchema,
    handler: (root, args) => handleSetControlLayout(root, args),
  });
  registry.register({
    name: 'set_control_size_flags',
    description: 'Set a Control\'s horizontal/vertical size flags (fill, expand, expand_fill, shrink_center, shrink_end).',
    schema: setControlSizeFlagsSchema,
    handler: (root, args) => handleSetControlSizeFlags(root, args),
  });
  registry.register({
    name: 'set_control_text',
    description: 'Set a text-like property on a Control (text, placeholder_text, title, ...).',
    schema: setControlTextSchema,
    handler: (root, args) => handleSetControlText(root, args),
  });
  registry.register({
    name: 'set_control_theme_override',
    description: 'Apply theme_override_* properties to a Control (e.g. theme_override_font_sizes/font_size).',
    schema: setControlThemeOverrideSchema,
    handler: (root, args) => handleSetControlThemeOverride(root, args),
  });
  registry.register({
    name: 'set_control_texture',
    description: 'Assign a texture resource to a Control property (TextureRect, Button, ...).',
    schema: setControlTextureSchema,
    handler: (root, args) => handleSetControlTexture(root, args),
  });
  registry.register({
    name: 'connect_node_signal',
    description: 'Connect a signal on one node to a method on another node in the edited scene (undoable, saved).',
    schema: connectNodeSignalSchema,
    handler: (root, args) => handleConnectNodeSignal(root, args),
  });

  // ---- Runtime events (1) ----
  registry.setCategory('Leeheisen: Runtime Events');
  registry.register({
    name: 'get_runtime_events',
    description: 'Sampled history of the running game: node add/remove and watched-property changes, newest last. Requires the godot_mcp_runtime autoload.',
    schema: getRuntimeEventsSchema,
    handler: (root, args) => handleGetRuntimeEvents(root, args),
  });

  // ---- C# / .NET (4) ----
  registry.setCategory('Leeheisen: C# / .NET');
  registry.register({
    name: 'get_dotnet_project_info',
    description: 'Godot .NET project info: .csproj/.sln files, target frameworks, assembly name and the C# script inventory.',
    schema: getDotnetProjectInfoSchema,
    handler: (root) => handleGetDotnetProjectInfo(root),
  });
  registry.register({
    name: 'create_csharp_script',
    description: 'Create a C# script from a Godot-correct template (PascalCase class name from the file, partial, namespace, [Tool], using System).',
    schema: createCsharpScriptSchema,
    handler: (root, args) => handleCreateCsharpScript(root, args),
  });
  registry.register({
    name: 'validate_csharp_project',
    description: 'Probe the .NET SDK for a Godot C# project, optionally running `dotnet build` (run_build=true) and returning the raw output.',
    schema: validateCsharpProjectSchema,
    handler: (root, args) => handleValidateCsharpProject(root, args),
  });
  registry.register({
    name: 'get_csharp_errors',
    description: 'Run `dotnet build` on the Godot C# project and return only the compiler diagnostics. Fills the gap left by .cs being treated as plain text.',
    schema: getCsharpErrorsSchema,
    handler: (root, args) => handleGetCsharpErrors(root, args),
  });

  // ---- Misc upgrades (4) ----
  registry.setCategory('Leeheisen: Script & Scene Utilities');
  registry.register({
    name: 'patch_script',
    description: 'Surgically patch a script: find/replace (all or first), prepend and/or append, with an optional .bak backup.',
    schema: patchScriptSchema,
    handler: (root, args) => handlePatchScript(root, args),
  });
  registry.register({
    name: 'create_packed_scene_from_node',
    description: 'Extract a node subtree from the edited scene into its own .tscn PackedScene (the inverse of editor_instantiate_scene).',
    schema: createPackedSceneFromNodeSchema,
    handler: (root, args) => handleCreatePackedSceneFromNode(root, args),
  });
  registry.register({
    name: 'generate_project_skills',
    description: 'Generate Godot MCP project skill files plus an AGENTS.md bridge block so AI clients get project-specific guidance.',
    schema: generateProjectSkillsSchema,
    handler: (root, args) => handleGenerateProjectSkills(root, args),
  });
  registry.register({
    name: 'get_performance_snapshot',
    description: 'Lightweight editor/runtime performance metrics plus whether a game is currently playing.',
    schema: getPerformanceSnapshotSchema,
    handler: (root) => handleGetPerformanceSnapshot(root),
  });
}
