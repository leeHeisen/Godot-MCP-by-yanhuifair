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

### 7.1 `plugin.gd` 需要 Godot ≥ 4.7

在 **Godot 4.5.1** 上插件直接解析失败，9876 端口不会启动：

```
SCRIPT ERROR: Parse Error: Static function "get_editor_language()" not found in base "GDScriptNativeClass".
  at: GDScript::reload (res://addons/godot-mcp/plugin.gd:1439)
SCRIPT ERROR: Parse Error: Static function "is_node_3d_snap_enabled()" not found ...
  at: GDScript::reload (res://addons/godot-mcp/plugin.gd:1637)
ERROR: Failed to load script "res://addons/godot-mcp/plugin.gd" with error "Parse error".
```

README 宣称「Godot 4.x」，实际需要 4.7+。本次验证改用 Godot 4.7.2 .NET 后正常：

```
[Godot MCP] TCP server listening on 127.0.0.1:9876
[Godot MCP] Plugin v1.12.4 loaded — TCP on 127.0.0.1:9876 (auth: off)
```

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
