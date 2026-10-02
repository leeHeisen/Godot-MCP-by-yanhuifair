// Copyright (c) 2026 FairYan
// SPDX-License-Identifier: AGPL-3.0-or-later
// ============================================================
// addon_sync.ts — 运行时把 bundled addon 同步到用户 Godot 工程
// ============================================================
// 与 scripts/sync-addons.js 逻辑相同（按内容 SHA-1 比对，而非版本号），
// 但作为可复用的 TS 函数供 server 在启动时 / 插件上报版本时调用。
//
// 这是「打开 Godot 工程时插件自动检测并 self-update」的核心：server 始终是
// addon 的权威源，只要它连着工程，工程里的 addon 就应与 server 自带版本一致。
//
// 注意：scripts/sync-addons.js 是 postbuild 用的 CLI 孪生实现，逻辑相同但独立
// 维护（sync-addons.js 由 node 直接执行、无法 import .ts）。修改比对逻辑时两处都要改。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/utils => ../../addons/godot-mcp ; dist/utils => ../../addons/godot-mcp
const SOURCE_ADDONS = path.resolve(__dirname, '..', '..', 'addons', 'godot-mcp');

export interface AddonSyncResult {
  /** 是否发生了文件写入（内容有差异） */
  updated: boolean;
  /** 差异原因（updated=false 时为 null） */
  reason: string | null;
  /** server 自带 addon 的版本号（来自 plugin.cfg） */
  version: string;
}

function readPluginVersion(pluginCfgPath: string): string {
  if (!fs.existsSync(pluginCfgPath)) return '?';
  const content = fs.readFileSync(pluginCfgPath, 'utf-8');
  const m = content.match(/^version\s*=\s*"(.+?)"/m);
  return m ? m[1] : '?';
}

function listFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

function hashFile(p: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

function diffReason(srcDir: string, dstDir: string): string | null {
  if (!fs.existsSync(dstDir)) return 'target does not exist';

  const srcFiles = listFiles(srcDir);
  const dstFiles = listFiles(dstDir);

  const missing = srcFiles.filter((f) => !dstFiles.includes(f));
  if (missing.length) return `target is missing ${missing.length} file(s): ${missing.slice(0, 3).join(', ')}`;

  // Godot 会在目标工程里自己生成 .uid / .import 等元文件，它们本来就不该
  // 存在于源目录，不能当成“过期文件”，否则每次都误判为需要同步。
  const isEngineArtifact = (f: string) => /\.(uid|import)$/.test(f);
  const extra = dstFiles.filter((f) => !srcFiles.includes(f) && !isEngineArtifact(f));
  if (extra.length) return `target has ${extra.length} stale file(s): ${extra.slice(0, 3).join(', ')}`;

  const changed = srcFiles.filter(
    (f) => hashFile(path.join(srcDir, f)) !== hashFile(path.join(dstDir, f)),
  );
  if (changed.length) return `${changed.length} file(s) changed: ${changed.slice(0, 3).join(', ')}`;

  return null;
}

/**
 * 把 server 自带的 addon 同步到用户的 Godot 工程。
 * 仅在内容有差异时才写文件（避免无意义的写入），返回是否发生了更新。
 */
export function syncAddonToProject(projectRoot: string): AddonSyncResult {
  const targetAddons = path.join(projectRoot, 'addons', 'godot-mcp');
  const srcVer = readPluginVersion(path.join(SOURCE_ADDONS, 'plugin.cfg'));
  const reason = diffReason(SOURCE_ADDONS, targetAddons);
  if (!reason) {
    return { updated: false, reason: null, version: srcVer };
  }
  fs.cpSync(SOURCE_ADDONS, targetAddons, { recursive: true, force: true });
  return { updated: true, reason, version: srcVer };
}
