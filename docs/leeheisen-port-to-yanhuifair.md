# Godot-MCP-by-yanhuifair → `leeheisen` 分支移植报告

- 日期：2026-10-02
- 仓库：`D:\GIT\LiHaishan\McpToolsGithub\Godot-MCP-by-yanhuifair`
- 分支：`leeheisen`（基于 `master`，当前工作区未提交）
- 基线版本：`@yanhuifair/godot-mcp` v1.12.4（AGPL-3.0-or-later）
- 移植来源：`funplay-godot-mcp` v0.10.0（MIT）

---

## 1. 目标与范围

把 funplay-godot-mcp 中若干高价值工具迁移进 Godot-MCP-by-yanhuifair，并满足两条硬性约束：

1. **尽量不动 yanhuifair 原有脚本**，降低将来合并上游提交时的冲突。
2. **迁移完成后打开真实 Godot 做端到端验证**，不接受仅靠单元测试或代码阅读的结论。

本次迁移覆盖了此前给出的全部三档建议：第一档 4 项、第二档 UI 工具链及其余 8 项、以及结合 C# 场景的 4 项。

> **2026-10-02 第二轮复审：** 首版提交（`4a049c7`）经独立复审又修掉了 5 类问题（lint、测试门禁、文档计数、实例化场景被写坏、C# 无法真机运行），并做了第二轮真机验证。详见 **§11**。

---

## 2. 结论摘要

- 工具数 **386 → 415（新增 29 个）**，无重名、无覆盖。
- 上游仅改动 **2 个文件、共 12 行插入**；`register.ts`、`plugin.gd`、`runtime_bridge.gd`、`scene.ts`、`script.ts` **一行未改**。
- 全部 29 个工具在 **Godot 4.7.2 stable .NET** 上完成真机验证：编辑器桥（TCP 9876）与运行中游戏桥（TCP 9877）均连通。
- 用 Godot 自带 `load_check.gd` 校验被工具改写的工程：**`TOTAL=23 OK=23 BAD=0`**，产出的 `.tscn` 引擎可直接加载。
- 为守住约束 1，验证过程中发现并**绕开**了 6 个上游缺陷（详见第 7 节），没有修改任何上游文件去修它们。

---

## 3. 改动清单

### 3.1 上游文件改动（共 12 行）

| 文件 | 改动 | 说明 |
|---|---|---|
| `src/server.ts` | +4 行 | 1 行 import + 3 行调用 `registerLeeheisenTools(sharedRegistry)` |
| `src/utils/registry.ts` | +8 行 | 20 个新写入类工具追加进 `WRITE_TOOLS`（read-only 模式隔离） |

### 3.2 新增模块（10 个文件，约 2600 行）

> 下表的行数是首版草稿值（偏小），修复后的当前行数见 §11.5。

全部位于 `src/tools/leeheisen/`：

| 文件 | 行数 | 职责 |
|---|---:|---|
| `common.ts` | 149 | 共享助手：结果构造、read-only 守卫、路径/语言检测、匹配计数 |
| `refactor.ts` | 223 | `plan_script_refactor` / `apply_script_refactor` |
| `project_map.ts` | 310 | `map_project` / `analyze_scene_complexity` |
| `assertions.ts` | 238 | 三个断言工具 |
| `ui.ts` | 468 | Control/UI 构建工具链（13 个工具） |
| `runtime_events.ts` | 156 | `get_runtime_events`（采样 + 环形缓冲 + 差分） |
| `dotnet.ts` | 267 | `get_dotnet_project_info` / `create_csharp_script` / `validate_csharp_project` / `get_csharp_errors` |
| `misc.ts` | 295 | `patch_script` / `create_packed_scene_from_node` / `generate_project_skills` / `get_performance_snapshot` |
| `scene_files.ts` | 208 | `.tscn` 文件级改写、节点路径、ext_resource 分配、子树抽取、连接写入 |
| `register.ts` | 268 | 单一注册入口 `registerLeeheisenTools(registry)` |

### 3.3 新增工具清单（29 个）

**重构（2）**：`plan_script_refactor`、`apply_script_refactor`

**工程地图（2）**：`map_project`、`analyze_scene_complexity`

**断言（3）**：`assert_node_exists`、`assert_node_property`、`assert_signal_connected`

**UI 工具链（13）**：`create_ui_root`、`create_control`、`create_label`、`create_button`、`create_panel`、`create_container`、`create_texture_rect`、`set_control_layout`、`set_control_size_flags`、`set_control_text`、`set_control_theme_override`、`set_control_texture`、`connect_node_signal`

**运行时事件（1）**：`get_runtime_events`

**C# / .NET（4）**：`get_dotnet_project_info`、`create_csharp_script`、`validate_csharp_project`、`get_csharp_errors`

**脚本与场景工具（4）**：`patch_script`、`create_packed_scene_from_node`、`generate_project_skills`、`get_performance_snapshot`

registry 实测：基线 386 → 415；29 个全部可在 registry 中命中；20 个写入类工具在 `--read-only` 下全部隐藏（可见数 177 / 415）。

---

## 4. 关键架构决策

### 4.1 注册点放在 server.ts，而不是 register.ts

`registerAllTools()` 位于上游 `register.ts`，是上游提交最频繁的文件之一。新工具改由 `server.ts` 里多调用一次 `registerLeeheisenTools()` 完成注册，`register.ts` 保持零改动。

### 4.2 不修改 plugin.gd 与 runtime_bridge.gd

上游 Godot 侧脚本（`addons/godot-mcp/plugin.gd`、`runtime_bridge.gd`）被明确划为不可改区域。所有编辑器侧能力都通过**组合上游已有命令**实现，不改动插件源码。

### 4.3 需要资源级操作的工具改走 `.tscn` 文件

插件自带的 `run_gdscript` 只能求值一个裸 `Expression`，且以场景根节点作为 base 实例，导致 `EditorInterface`、`ResourceSaver`、`load()` 等全局单例不可达。因此涉及「给属性赋资源」「抽取子树」等操作改为直接改写 `.tscn`，再让编辑器重新同步。

### 4.4 编辑器同步采用 close → open，而不是 reload

实测发现 `reload_scene` 会**先 `save_scene()` 再 reload**，等于用内存里的旧场景覆盖刚写入的文件改动；而 `open_asset` 对已打开的场景是空操作。唯一能真正读到磁盘改动的序列是：

```
save_scene → 改写 .tscn → close_scene → open_asset(同一路径)
```

代价是这些工具会丢失该场景的撤销历史，返回值中以 `editor_resynced` 字段标注。

### 4.5 信号连接改为文件级写入

插件自带的 `connect_editor_signal` 在 Godot 4 下连接后不标记场景为脏，`save_scene()` 因此永不落盘，连接在 reload 后即丢失（已实测复现）。`connect_node_signal` 改为直接写 `.tscn` 的 `[connection]` 段。

### 4.6 子树抽取完全离线

`create_packed_scene_from_node` 通过解析 `.tscn` + 复用上游 `serializeScene` 生成新场景，不依赖编辑器，顺带契合 yanhuifair「可脱离 Godot 改工程文件」的定位，并会自动只保留子树实际引用的 ext/sub resource。

---

## 5. 验证环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows |
| Godot（最终验证） | **4.7.2 stable .NET（mono）** |
| Godot（首次尝试） | 4.5.1 stable .NET —— **插件无法加载**，见第 7.1 节 |
| .NET SDK | 9.0.303 |
| Node.js | v22.11.0 |
| 验证工程 | `test/test-project` 的副本，追加 `godot_mcp_runtime` autoload |
| 依赖 | 仓库 `node_modules`（`npm ci`） |

> 补充：仓库自带的 vitest 套件在本机无法运行（`@rolldown/binding-wasm32-wasi` 缺失，且 Node 22.11 低于 vite/vitest 要求的 22.12），属环境问题，与本次改动无关。因此验证改为「直接驱动真实 registry + 真实 Godot」两条路径。

---

## 6. 验证结果

### 6.1 离线（Node 侧，无需 Godot）

| 工具 | 结果 |
|---|---|
| `map_project` | 输出 JSON，识别 9 个场景 / 4 个脚本 / 34 个节点 / 5 条边 |
| `analyze_scene_complexity` | 逐场景给出节点数、最大深度、类型分布、复杂度评分与评级 |
| `plan_script_refactor` | dry-run 正确列出跨文件命中与行预览，**文件未被修改**（已断言） |
| `apply_script_refactor` | 缺少 `confirm` 时拒绝；带 `apply+confirm` 时改文件并生成 `.bak`（已断言） |
| `patch_script` | find/replace/prepend/append 生效，字节数变化正确 |
| `generate_project_skills` | 生成 3 个 skill 文件 + `AGENTS.md` 桥接块 |
| `get_dotnet_project_info` | 识别 `test.csproj`、`net8.0`、C# 脚本清单 |
| `create_csharp_script` | 生成 PascalCase 类名 + `partial` + 正确基类的 C# 文件 |
| `validate_csharp_project` | 探测到 `dotnet --version = 9.0.303` |
| `get_csharp_errors` | **真实执行 `dotnet build`，exit 0、0 错误** |

### 6.2 真机（Godot 4.7.2 .NET，编辑器桥 TCP 9876）

| 工具 | 结果 |
|---|---|
| `assert_node_exists` | 通过路径返回 `passed:true`；不存在路径返回 `passed:false` + `isError`，并附带可用节点路径样本 |
| `assert_node_property` | 值相等通过；不等时返回 `isError` 并给出期望/实际值 |
| `assert_signal_connected` | 精确匹配通过；错误方法名正确判失败（区分能力已验证） |
| `create_ui_root` / `create_container` / `create_label` / `create_button` | 节点创建成功，属性落盘 |
| `create_texture_rect` | 创建 + ext_resource 注册 + 纹理赋值 + 编辑器重同步 |
| `set_control_texture` | `icon = ExtResource("2_lee")` 正确写入 `.tscn` |
| `set_control_layout` / `set_control_size_flags` / `set_control_text` / `set_control_theme_override` | 全部 applied，无 failed_properties |
| `connect_node_signal` | `[connection signal="pressed" from="LeeUI/LeeBox/LeeButton" to="." method="_on_lee_button_pressed"]` 正确落盘 |
| `create_packed_scene_from_node` | 生成 `scenes/lee_ui.tscn`，5 节点、资源与连接正确重写 |
| `get_performance_snapshot` | 返回引擎性能监视器 + 是否在播放 |

### 6.3 引擎级校验（最强证据）

对工具改写后的工程运行 Godot 自带 `load_check.gd`：

```
  SCENE res://scenes/lee_ui.tscn    root=LeeUI   children=2
  SCENE res://scenes/main.tscn      root=Main    children=4
TOTAL=23 OK=23 BAD=0
exit=0
```

即：**被移植工具创建、改写、抽取出来的场景，Godot 引擎本身可以正常加载与实例化**。

### 6.4 运行中游戏（TCP 9877）

| 工具 | 结果 |
|---|---|
| `get_runtime_events` | 成功连接运行中的游戏，采样到场景树（root=Main，9 节点）；捕获到真实 `property_changed` 事件 |

---

## 7. 验证中发现的上游缺陷（均已绕开，未修改上游）

### 7.1 `plugin.gd` 需要 Godot ≥ 4.6（原报告写作 4.7，已由 §12 修正并修复）

在 **Godot 4.5.1** 上插件直接解析失败，9876 端口不会启动：

```
SCRIPT ERROR: Parse Error: Static function "get_editor_language()" not found in base "GDScriptNativeClass".
  at: GDScript::reload (res://addons/godot-mcp/plugin.gd:1439)
SCRIPT ERROR: Parse Error: Static function "is_node_3d_snap_enabled()" not found ...
  at: GDScript::reload (res://addons/godot-mcp/plugin.gd:1637)
ERROR: Failed to load script "res://addons/godot-mcp/plugin.gd" with error "Parse error".
```

README 宣称「Godot 4.x」，实际需要 4.6+（缺失的 5 个 API 在 4.6 官方文档中已出现，4.7.2 实机确认存在）。本次验证改用 Godot 4.7.2 .NET 后正常：

```
[Godot MCP] TCP server listening on 127.0.0.1:9876
[Godot MCP] Plugin v1.12.4 loaded — TCP on 127.0.0.1:9876 (auth: off)
```

**该项已在 §12 修复：现在 Godot 4.5.x 也能正常加载插件并使用全部编辑器工具。**

### 7.2 `run_gdscript` 无法访问全局单例

`_cmd_run_gdscript` 以场景根节点作为 `Expression` 的 base 实例，`EditorInterface` / `ResourceSaver` / `load()` 等全部不可达：

```
Execution error: 将 'EditorInterface' 作为 Object 基础类型的具名索引无效
Execution error: 将 'ResourceSaver' 作为 Object 基础类型的具名索引无效
```

**影响**：任何需要资源加载/保存的编辑器侧操作都无法通过该逃生口实现。

### 7.3 `connect_editor_signal` 的连接不会落盘

连接只在内存生效（`list_node_signals` 显示 `connections: 1`），`save_scene()` 后 `.tscn` 中仍无 `[connection]`；补调 `mark_scene_unsaved` 亦无效；关闭并重开场景后连接彻底丢失。

**影响**：上游的 `editor_connect_signal` / `connect_editor_signal` 实质不可用于持久化。

### 7.4 `reload_scene` 会覆盖外部文件改动

实现为 `save_scene()` → `reload_scene_from_path()`，先写内存旧状态，再读回被自己覆盖的文件。

### 7.5 `open_asset` 对已打开场景是空操作

无法用于「重新从磁盘加载」。

### 7.6 `list_node_signals` 在 Godot 4 下丢失 target/method

实现读取 `c.get("method")` / `c.get("target")`，而 Godot 4 的连接字典使用 `callable` 键，因此返回：

```json
"targets": [{ "method": "", "target": "" }]
```

**影响**：只能拿到连接数量，无法拿到连接目标。

---

## 8. 已知限制

1. **`get_runtime_events` 只能看到 EDITOR-usage 属性。** 运行时桥的 `_node_info` 以 `PROPERTY_USAGE_EDITOR` 过滤，因此普通脚本变量（如示例工程的 `score`）不可见；导出变量与引擎属性可见。
2. **断言基于已保存的 `.tscn`。** `assert_signal_connected` 的精确匹配读取磁盘场景文件；若连接刚建立而场景尚未保存，需先保存。工具返回中会给出 `scene_file_connections` 供排查。
3. **文件级改写的工具会丢失该场景的撤销历史**（close → open 同步的代价），返回值以 `editor_resynced` 标注。
4. **C# 校验是整工程 `dotnet build`**，需要机器安装 .NET SDK 并在 PATH 中；不提供单文件诊断。
5. **`.cs` 仍无 Roslyn 语义分析**：`map_project` 对 C# 的类/方法/`[Export]` 提取仍是逐行启发式。
6. **UI 工具依赖编辑器打开场景**（`create_*` / `set_*` 走编辑器桥）；只有 `create_packed_scene_from_node`、`map_project`、重构、C# 校验等完全离线。

---

## 9. 未完成 / 后续建议

- [ ] 分支 `leeheisen` 的内容尚未提交（工作区状态），由 review 后决定提交粒度与信息。
- [ ] 若要让 UI 工具**保留编辑器撤销历史**，必须修改 `plugin.gd`（新增命令）——与约束 1 冲突，需要另行决策。
- [ ] 可考虑向 yanhuifair 上游反馈第 7 节的 6 个缺陷（尤其 7.3 与 7.1）。
- [ ] `get_runtime_events` 若需覆盖普通脚本变量，需要运行时桥暴露非 EDITOR 属性（同样涉及改动上游）。
- [ ] 上游 `--read-only` 的 `tools/list` 过滤已正确覆盖新工具，但 `README` 中的工具计数（386/30 分类）尚未更新。

---

## 10. 产物与清理

**代码**

- 新目录：`src/tools/leeheisen/`（10 文件）
- 修改：`src/server.ts`、`src/utils/registry.ts`
- 本报告：`docs/leeheisen-port-to-yanhuifair.md`（随 `leeheisen` 分支一起保存）
- `git status`（分支 `leeheisen`）：`M src/server.ts`、`M src/utils/registry.ts`、`?? src/tools/leeheisen/`、`?? docs/`（另有原本就存在的 `?? .idea/`）

**验证用临时产物（均可删除）**

| 路径 | 内容 |
|---|---|
| `%TEMP%\godot472\` | Godot 4.7.2 stable .NET（因本机仅有 4.5.1，插件无法加载而下载） |
| `%TEMP%\leeheisen-live\` | `test/test-project` 的验证副本，含 `godot_mcp_runtime` autoload |
| `%TEMP%\leeheisen-editor-out.log` / `-err.log` | 编辑器 stdout/stderr 捕获 |
| `%TEMP%\leeheisen-*`、`%TEMP%\gmcp-*` | 各阶段临时工程与脚本 |

**遗留物**

- `D:\GIT\LiHaishan\McpToolsGithub\src\tools` 是一个**空目录**（早期 patch 路径书写失误产生），删除命令被环境策略拦截，可手动删除。
- 目前已无 Godot 进程残留。

---

## 11. 复审修复与第二轮验证（2026-10-02）

首版提交 `4a049c7` 之后做了一次独立复审，发现 5 类问题并全部修复。

### 11.1 修复清单

| # | 问题 | 修复 |
|---|---|---|
| 1 | `npm run lint` 有 3 个 error，全部在新代码 | `project_map.ts` 去掉字符类里多余的 `\[` 转义、去掉 `nodeCount * 1`；`scene_files.ts` 的 `closed` 改为无初始值 |
| 2 | 仓库自带测试挂 2 条 | ① `WRITE_TOOLS` 里的 20 个新工具不在 `registerAllTools()` 的注册表里 → `test/structural.test.ts` 的两个结构测试与 `registryCount()` 一并注册 `registerLeeheisenTools()`；② 10 个新文件的版权头不符合仓库约定 → 统一为 `Copyright (c) 2026 FairYan, Leeheisen` + `Ported from funplay-godot-mcp (MIT, ...)` |
| 3 | 文档计数漂移 | `README.md` / `README-zh.md` / `package.json`：386 → **415**、30 → **37 个分类**，Feature Overview 增加 7 行 Leeheisen 分类 |
| 4 | **整文件改写会写坏含实例化节点的场景**（`type=""`、`instance="ExtResource("x")"`、丢 `[editable]`/`unique_id`） | 新增 `src/tools/leeheisen/scene_text.ts`，所有写操作改为原文文本编辑；`set_control_texture` / `create_texture_rect` / `connect_node_signal` / `create_packed_scene_from_node` 不再走 `serializeScene()` |
| 5 | 仓库自带 `test/test-project` 有 `.csproj` 却缺少 `[dotnet] project/assembly_name`，C# 场景在真机上无法实例化（`Failed to load project assembly`） | `test/test-project/project.godot` 补上该设置（`test`，与 `test.csproj` 一致） |

### 11.2 第二轮验证结果

环境：Windows / Node **v22.23.3** / .NET SDK 9.0.303 / Godot **4.7.2 stable .NET (mono)**，工程为 `test/test-project` 的临时副本。

| 项目 | 方式 | 结果 |
|---|---|---|
| 构建 | `npm run build` | 通过 |
| Lint | `npx eslint . --quiet`（经 WebStorm MCP 的 `lint_files` + IDE 终端执行） | **0 error** |
| 单元 / 结构测试 | `npx vitest run` | **154 passed / 70 skipped / 0 failed**（修复前 2 failed） |
| 场景格式回归 | 含实例化根节点 + `[editable]` + `unique_id` 的场景，依次跑 `connect_node_signal`、`set_control_texture`、`create_packed_scene_from_node` | 原文保留 `instance=ExtResource("…")`、`[editable]`、`unique_id`；引擎校验 `TOTAL=24 OK=24 BAD=0`（修复前同一场景 `BAD: load failed`） |
| UI 工具链 + 断言 | 13 个 UI 工具 + 3 个断言工具 | 全部 ok，`failed_properties` 为空，断言返回 `passed:true` |
| C# 端到端 | `create_csharp_script` 生成 `scripts/CSharpProbe.cs`（`[Export] public int Score`）→ `editor_attach_script` 挂到新建的 `Node2D` 场景 → `get_csharp_errors`（`dotnet build` exit 0）→ .NET 版引擎运行场景 | 引擎输出 `CSHARP_PROBE_READY score=7`；带 namespace 与不带 namespace 各验证一次 |
| 运行态事件 | 编辑器 play + `runtime_set_node` 改 `player_speed` | `get_runtime_events` 捕获 `property_changed: player_speed: 200.0 -> 42.0` |
| 旧缺陷回归 | Godot **4.5.1** 打开工程 | 仍复现 §7.1 的 `plugin.gd` 解析失败（上游问题，本次未改） |

### 11.3 与 funplay 的接口差异（重要）

这 29 个工具是**功能对齐、接口重写**，不是 drop-in 兼容；从 funplay 迁移提示词时必须改参数名：

| 工具 | funplay 参数 | 本分支参数 |
|---|---|---|
| `create_ui_root` | `kind`(canvas_layer/control)、`control_name`、`layout_preset` | `type`(Control/CanvasLayer)、`full_rect`、`properties` |
| `create_control` | `control_type` | `type` |
| `create_container` | `container_type`（必填） | `type`（可选，默认 VBoxContainer） |
| `create_texture_rect` | `texture_path`、`stretch_mode`、`expand_mode` | `texture_path`、`stretch_mode`、`properties` |
| `set_control_layout` | `layout_preset`、`anchors`/`offsets`（对象）、`grow_*`（整数） | `preset`（名称/序号）、`anchors`/`offsets`（`"l,t,r,b"`）、`grow_*`（begin/end/both） |
| `set_control_theme_override` | `override_type`/`name`/`value` | `overrides`（字典） |
| `set_control_texture` | `node_path`、`texture_path`、`stretch_mode`/`expand_mode` | `node_path`、`texture_path`、`property` |
| `create_packed_scene_from_node` | `node_path`、`path`、`select_file` | `node_path`、`output_path`、`scene_path`、`keep_owner` |
| `assert_signal_connected` | `source_path`/`signal_name`/`target_path`/`method_name` | `from_node`/`signal`/`to_node`/`method` |
| `assert_node_property` | `expected`（任意 JSON） | `expected`（字符串） |
| `get_runtime_events` | `timeout_msec`、`max_events` | `sample`/`clear`/`max_events`/`watch_node`/`event_type` |
| `generate_project_skills` | `endpoint`、`include_agents_bridge` | `output_dir`、`write_agents_md`、`overwrite` |
| `map_project` | `include_scripts`/`include_graph`/`max_files` | `path`/`format`/`output_path`/`include_addons`/`max_scripts` |
| `get_performance_snapshot` | 编辑器 FPS / time_scale / 当前场景摘要 | 引擎 performance monitors + `is_playing` |
| `analyze_scene_complexity` | 无参数，分析**当前编辑场景** | `scene_path`/`top_types`，离线分析工程内 `.tscn` |

### 11.4 已知取舍

- 文本级改写保留所有未知语法，但 `create_packed_scene_from_node` 抽取子树时仍只保留**被引用**的 ext/sub resource（与首版一致）。
- `unique_id` 由 Godot 4.7 编辑器维护：工具写入后编辑器会"关闭→重开"场景，Godot 自己会补 `index`/`unique_id`/`layout_mode`，属预期行为。
- 编辑器侧工具原本要求 Godot ≥ 4.6（§7.1）；已按 §12 修复，现在 **4.5+ 可用**（仅 `get_3d_snap` 在 4.5 上返回能力错误）。

### 11.5 当前文件行数（第二轮）

| 文件 | 行数 |
|---|---:|
| `common.ts` | 172 |
| `refactor.ts` | 244 |
| `project_map.ts` | 342 |
| `assertions.ts` | 264 |
| `ui.ts` | 536 |
| `runtime_events.ts` | 175 |
| `dotnet.ts` | 304 |
| `misc.ts` | 336 |
| `scene_files.ts` | 130 |
| `scene_text.ts`（新增） | 338 |
| `register.ts` | 278 |
| **合计** | **3119** |

## 12. 4.5 兼容性修复（plugin.gd 版本门禁，2026-10-02 第三轮）

目标：让本 MCP 在 **Godot ≥ 4.5** 上可用（私有 fork，直接改上游文件，不再考虑 PR/版权）。

### 12.1 根因

`plugin.gd` 有 6 处直接引用 `EditorInterface` 的 5 个方法：
`get_editor_language()`（1439、1648 行）、`is_node_3d_snap_enabled()` / `get_node_3d_translate_snap()` /
`get_node_3d_rotate_snap()` / `get_node_3d_scale_snap()`（1637-1640 行）。

GDScript 对 `类.方法` 是**编译期**解析：方法在运行引擎里不存在 → **整个 plugin.gd parse error** →
`_enter_tree()` 不执行 → 9876 不监听 → 所有依赖编辑器桥的工具（Editor 分类 140 个 + 本分支 UI 13 + 断言 3 + 性能快照 1）全部不可用，
spawn 回退同样无效（拉起的是同一个坏插件）。为了 3 个命令的实现，陪葬整个插件。

实机 API 探测（自写 `has_method` 探针插件，`--doctool` 的 XML 对 EditorInterface 不完整、不作依据）：

| API | 4.5.1 | 4.7.2 |
|---|---|---|
| `get_editor_language` / `is_node_3d_snap_enabled` / `get_node_3d_{translate,rotate,scale}_snap` | ❌ | ✅ |
| `get_unsaved_scenes` | ❌（早已 `has_method` 守卫） | ✅ |
| `close_scene`、`is_movie_maker_enabled`、`set_distraction_free_mode` 等 | ✅ | ✅ |

官方文档：这 5 个方法在 **4.6** 的类参考里已存在 → 真实最低版本是 4.6（原报告 §7.1 的 "4.7" 已更正）。

### 12.2 修复方案

`addons/godot-mcp/plugin.gd` 顶部新增版本门禁助手，并让 3 个命令走它：

```gdscript
func _editor_has(method: String) -> bool:
	return EditorInterface.has_method(method)

func _editor_call(method: String, fallback = null) -> Variant:
	if not EditorInterface.has_method(method):
		return fallback
	return EditorInterface.call(method)
```

- `_cmd_get_editor_info` / `_cmd_get_editor_paths`：`editor_language` 在 4.5 降级为 `""`；
- `_cmd_get_3d_snap`：4.5 上返回明确的 `get_3d_snap requires Godot 4.6+ (...)` 能力错误（MCP 侧表现为带修复提示的 `EDITOR_COMMAND_FAILED`）；
- **关键约束**：不能写成 `X if has_method(...) else Y`——直接引用仍进 AST，仍在编译期解析，照样 parse error；必须用 `.call("名字")`。
- 文件头由「Godot 4.x only」改为「Godot 4.5+ (minimum supported)」，并注释说明该门禁模式。

插件的自更新是按**内容哈希**同步的（`scripts/sync-addons.js` 注释里写明了原因），所以同版本号内的这次修改也会被同步进用户工程，无需升版本号。

### 12.3 真机验证

| 环境 | 项目 | 结果 |
|---|---|---|
| **Godot 4.5.1 mono** | 插件加载 | stderr 无任何 parse error，stdout `[Godot MCP] TCP server listening on 127.0.0.1:9876` |
| | `editor_get_info` / `editor_get_paths` | ok（Language 显示为空，属预期降级） |
| | `editor_get_3d_snap` | 返回 `requires Godot 4.6+` 的明确错误（插件不再被带崩） |
| | 移植工具：`connect_node_signal`、`set_control_texture`、`create_packed_scene_from_node` | ok，实例化语法保留，`editor_resynced: true`（4.5 已有 `close_scene`） |
| | 13 个 UI 工具 + 3 个断言 | 全部 ok，`failed_properties` 为空 |
| | 引擎级校验（工具改写后） | `TOTAL=24 OK=24 BAD=0` |
| | 运行时桥（autoload + play） | `get_runtime_events` 捕获 `property_changed: player_speed: 200.0 -> 42.0` |
| | C# 端到端（`Godot.NET.Sdk/4.5.1`） | `create_csharp_script` → `editor_attach_script` → `dotnet build`(0 error) → 引擎输出 `CSHARP_PROBE_READY score=7` |
| **Godot 4.7.2**（回归） | 插件加载 + `editor_get_3d_snap` | 正常，返回真实值（translate 1 / rotate 15 / scale 10） |
| | UI 工具链 | 全部 ok，无回归 |

## 附：验证命令速查

```powershell
# 构建
cd D:\GIT\LiHaishan\McpToolsGithub\Godot-MCP-by-yanhuifair
npm run build

# 引擎级场景校验（需 Godot 4.7+ .NET）
& "$env:TEMP\godot472\Godot_v4.7.2-stable_mono_win64\Godot_v4.7.2-stable_mono_win64_console.exe" `
  --headless --path "$env:TEMP\leeheisen-live" --script load_check.gd

# 打开编辑器（插件会监听 127.0.0.1:9876）
& "$env:TEMP\godot472\Godot_v4.7.2-stable_mono_win64\Godot_v4.7.2-stable_mono_win64_console.exe" `
  --editor --path "$env:TEMP\leeheisen-live"
```
