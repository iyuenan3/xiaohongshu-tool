// 媒体素材库: dialog 选图 / URL 导入 / 本地存储 / SQLite 记录
// 上传 pipeline: nativeImage.toJPEG(75) 压缩 + 重命名 picture-YYYYMMDD-HHmmss-N.jpg

import { app, dialog, nativeImage, net } from 'electron';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join, extname, basename } from 'path';
import log from 'electron-log/main';
import { getDb } from './db';

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const JPEG_QUALITY = 75;

export interface MediaAsset {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  source_url: string | null;
  storage_path: string;
  width: number | null;
  height: number | null;
  created_at: number;
  last_used_at: number;
  tags: string;      // JSON array string
  description: string | null;
  analyzed: number;  // 0/1
}

function assetsDir(): string {
  return join(app.getPath('userData'), 'assets');
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(assetsDir(), { recursive: true });
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function timestampStr(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 把任意输入 buffer 用 nativeImage 转 JPEG q75, 不缩尺寸. 失败时返回原 buffer. */
function toCompressedJpeg(buf: Buffer): { buf: Buffer; width: number | null; height: number | null } {
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return { buf, width: null, height: null };
    const size = img.getSize();
    const out = img.toJPEG(JPEG_QUALITY);
    return { buf: out, width: size.width || null, height: size.height || null };
  } catch (e) {
    log.warn('[assets] nativeImage compress failed, keep raw:', e);
    return { buf, width: null, height: null };
  }
}

function insertRecord(rec: Omit<MediaAsset, 'created_at' | 'last_used_at' | 'tags' | 'description' | 'analyzed'>): MediaAsset {
  const now = Date.now();
  const full: MediaAsset = {
    ...rec,
    created_at: now,
    last_used_at: now,
    tags: '[]',
    description: null,
    analyzed: 0,
  };
  getDb()
    .prepare(`INSERT INTO media_assets
      (id, filename, mime_type, size, source_url, storage_path, width, height, created_at, last_used_at, tags, description, analyzed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      full.id, full.filename, full.mime_type, full.size,
      full.source_url, full.storage_path, full.width, full.height,
      full.created_at, full.last_used_at, full.tags, full.description, full.analyzed,
    );
  return full;
}

/** 弹原生 dialog 选 1~N 张图片, 压缩 + 重命名后存盘 + 入库. */
export async function pickAndImport(): Promise<MediaAsset[]> {
  await ensureDir();
  const res = await dialog.showOpenDialog({
    title: '选择图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
  });
  if (res.canceled || res.filePaths.length === 0) return [];

  const out: MediaAsset[] = [];
  const ts = timestampStr();
  let idx = 0;
  for (const src of res.filePaths) {
    try {
      const ext = extname(src).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) {
        log.warn(`[assets] skip unsupported ext: ${src}`);
        continue;
      }
      idx++;
      const raw = await fs.readFile(src);
      const { buf: jpegBuf, width, height } = toCompressedJpeg(raw);
      const id = randomUUID();
      const storagePath = join(assetsDir(), `${id}.jpg`);
      await fs.writeFile(storagePath, jpegBuf);
      const displayName = `picture-${ts}-${idx}.jpg`;

      const rec = insertRecord({
        id,
        filename: displayName,
        mime_type: 'image/jpeg',
        size: jpegBuf.length,
        source_url: null,
        storage_path: storagePath,
        width,
        height,
      });
      out.push(rec);
      log.info(`[assets] imported: ${basename(src)} -> ${displayName} (${raw.length}B → ${jpegBuf.length}B)`);
    } catch (e) {
      log.error(`[assets] import failed for ${src}:`, e);
    }
  }
  return out;
}

/** 从 URL 下载, 压缩 + 重命名后存盘 + 入库. */
export async function importFromUrl(url: string): Promise<MediaAsset> {
  await ensureDir();
  const resp = await net.fetch(url);
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);
  const raw = Buffer.from(await resp.arrayBuffer());
  const { buf: jpegBuf, width, height } = toCompressedJpeg(raw);

  const id = randomUUID();
  const storagePath = join(assetsDir(), `${id}.jpg`);
  await fs.writeFile(storagePath, jpegBuf);
  const displayName = `picture-${timestampStr()}-1.jpg`;

  const rec = insertRecord({
    id,
    filename: displayName,
    mime_type: 'image/jpeg',
    size: jpegBuf.length,
    source_url: url,
    storage_path: storagePath,
    width,
    height,
  });
  log.info(`[assets] imported from URL: ${url} -> ${displayName} (${raw.length}B → ${jpegBuf.length}B)`);
  return rec;
}

export function listAssets(): MediaAsset[] {
  return getDb()
    .prepare(`SELECT * FROM media_assets ORDER BY last_used_at DESC`)
    .all() as MediaAsset[];
}

export function getAssetPath(id: string): string | null {
  const row = getDb()
    .prepare(`SELECT storage_path FROM media_assets WHERE id = ?`)
    .get(id) as { storage_path: string } | undefined;
  return row?.storage_path ?? null;
}

export function getAsset(id: string): MediaAsset | null {
  const row = getDb().prepare(`SELECT * FROM media_assets WHERE id = ?`).get(id) as MediaAsset | undefined;
  return row ?? null;
}

// Fisher-Yates 洗牌 (返回新数组)。素材选择/采样用: listAssets 排序是确定性的 (last_used_at DESC),
// 不洗牌会导致同标签永远选同一批图 (用户反馈: 素材固定)。
export function shuffleArray<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function touchUsed(ids: string[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const stmt = getDb().prepare(`UPDATE media_assets SET last_used_at = ? WHERE id = ?`);
  const txn = getDb().transaction((arr: string[]) => {
    for (const id of arr) stmt.run(now, id);
  });
  txn(ids);
}

export async function deleteAsset(id: string): Promise<void> {
  const row = getDb()
    .prepare(`SELECT storage_path FROM media_assets WHERE id = ?`)
    .get(id) as { storage_path: string } | undefined;
  if (!row) return;
  try {
    await fs.unlink(row.storage_path);
  } catch (e) {
    log.warn(`[assets] unlink failed (${row.storage_path}):`, e);
  }
  // 先清 junction 再删本体: FK 未开, 不清会留悬空 group_item → 选组发图时命中已删素材 → 发布失败 (坑防线)
  getDb().prepare(`DELETE FROM asset_group_item WHERE asset_id = ?`).run(id);
  getDb().prepare(`DELETE FROM media_assets WHERE id = ?`).run(id);
}

// ============ 素材分组 (用户反馈 0719: 多份素材自定义分组; 一图多组 junction) ============

export interface AssetGroup {
  id: number;
  name: string;
  created_at: number;
  count: number; // 组内素材数
}

export function listGroups(): AssetGroup[] {
  return getDb()
    .prepare(
      `SELECT g.id, g.name, g.created_at, COUNT(i.asset_id) AS count
       FROM asset_group g
       LEFT JOIN asset_group_item i ON i.group_id = g.id
       GROUP BY g.id
       ORDER BY g.created_at DESC`,
    )
    .all() as AssetGroup[];
}

export function createGroup(name: string): AssetGroup {
  const nm = name.trim();
  if (!nm) throw new Error('分组名不能为空');
  const info = getDb()
    .prepare(`INSERT INTO asset_group (name, created_at) VALUES (?, ?)`)
    .run(nm, Date.now());
  return { id: Number(info.lastInsertRowid), name: nm, created_at: Date.now(), count: 0 };
}

export function renameGroup(id: number, name: string): void {
  const nm = name.trim();
  if (!nm) throw new Error('分组名不能为空');
  getDb().prepare(`UPDATE asset_group SET name = ? WHERE id = ?`).run(nm, id);
}

export function deleteGroup(id: number): void {
  // 只删组与成员关系, 不删素材本体。两条 DELETE 包进事务 (与 add/remove 一致), 防崩溃遗留孤儿 junction/空组
  const txn = getDb().transaction((gid: number) => {
    getDb().prepare(`DELETE FROM asset_group_item WHERE group_id = ?`).run(gid);
    getDb().prepare(`DELETE FROM asset_group WHERE id = ?`).run(gid);
  });
  txn(id);
}

export function addAssetsToGroup(groupId: number, assetIds: string[]): void {
  if (!assetIds.length) return;
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO asset_group_item (group_id, asset_id) VALUES (?, ?)`,
  );
  const txn = getDb().transaction((ids: string[]) => {
    for (const aid of ids) stmt.run(groupId, aid);
  });
  txn(assetIds);
}

export function removeAssetsFromGroup(groupId: number, assetIds: string[]): void {
  if (!assetIds.length) return;
  const stmt = getDb().prepare(
    `DELETE FROM asset_group_item WHERE group_id = ? AND asset_id = ?`,
  );
  const txn = getDb().transaction((ids: string[]) => {
    for (const aid of ids) stmt.run(groupId, aid);
  });
  txn(assetIds);
}

// 组内素材 (按 last_used_at DESC, 与 listAssets 一致)。选组发图 / UI 过滤共用。
export function listAssetsByGroup(groupId: number): MediaAsset[] {
  return getDb()
    .prepare(
      `SELECT a.* FROM media_assets a
       JOIN asset_group_item i ON i.asset_id = a.id
       WHERE i.group_id = ?
       ORDER BY a.last_used_at DESC`,
    )
    .all(groupId) as MediaAsset[];
}

// 按组名解析组内素材 (Planner 输出组名, planned_publish 据名取图)。名称唯一性不强制, 取最近创建的一个。
export function listAssetsByGroupName(name: string): MediaAsset[] {
  const nm = name.trim();
  if (!nm) return [];
  const g = getDb()
    .prepare(`SELECT id FROM asset_group WHERE name = ? ORDER BY created_at DESC LIMIT 1`)
    .get(nm) as { id: number } | undefined;
  return g ? listAssetsByGroup(g.id) : [];
}

// 分组概览 (供 Planner buildContext: 组名 + 张数 + 代表性标签样本, 让 LLM 知道有哪些组可整组发)。
// 只列非空组: 空组喂给 Planner 可能被误选 → 回退散图弱匹配甚至无图 (review #7)。
export function groupsOverview(maxTagsPerGroup = 6): Array<{ name: string; count: number; tags: string[] }> {
  const out: Array<{ name: string; count: number; tags: string[] }> = [];
  for (const g of listGroups()) {
    if (g.count === 0) continue;
    const members = listAssetsByGroup(g.id);
    const tagSet = new Set<string>();
    for (const a of members) {
      try {
        for (const t of JSON.parse(a.tags || '[]') as string[]) {
          if (t) tagSet.add(t);
          if (tagSet.size >= maxTagsPerGroup) break;
        }
      } catch { /* ignore */ }
      if (tagSet.size >= maxTagsPerGroup) break;
    }
    out.push({ name: g.name, count: g.count, tags: [...tagSet] });
  }
  return out;
}

/** 标记一张图为已分析 (写入 LLM 给出的 tag 列表 + 描述). */
export function setAssetTags(id: string, tags: string[], description: string): void {
  getDb()
    .prepare(`UPDATE media_assets SET tags = ?, description = ?, analyzed = 1 WHERE id = ?`)
    .run(JSON.stringify(tags), description, id);
}

/** 按 tag / 描述 / 文件名模糊检索. AI 用 search_local_assets 工具调到这里. */
export function searchAssets(query: string, limit = 10): MediaAsset[] {
  const q = `%${query}%`;
  return getDb()
    .prepare(
      `SELECT * FROM media_assets
       WHERE tags LIKE ? OR description LIKE ? OR filename LIKE ?
       ORDER BY last_used_at DESC LIMIT ?`,
    )
    .all(q, q, q, limit) as MediaAsset[];
}
