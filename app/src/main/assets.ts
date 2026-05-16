// 媒体素材库: dialog 选图 / URL 导入 / 本地存储 / SQLite 记录

import { app, dialog, net } from 'electron';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join, extname, basename } from 'path';
import log from 'electron-log/main';
import { getDb } from './db';

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp',
};

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
}

function assetsDir(): string {
  return join(app.getPath('userData'), 'assets');
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(assetsDir(), { recursive: true });
}

function detectMime(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

function insertRecord(rec: Omit<MediaAsset, 'created_at' | 'last_used_at'>): MediaAsset {
  const now = Date.now();
  const full: MediaAsset = { ...rec, created_at: now, last_used_at: now };
  getDb()
    .prepare(`INSERT INTO media_assets
      (id, filename, mime_type, size, source_url, storage_path, width, height, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      full.id, full.filename, full.mime_type, full.size,
      full.source_url, full.storage_path, full.width, full.height,
      full.created_at, full.last_used_at,
    );
  return full;
}

/** 弹原生 dialog 选 1~N 张图片, 复制到 userData/assets, 写入 DB. 用户取消时返回 []. */
export async function pickAndImport(): Promise<MediaAsset[]> {
  await ensureDir();
  const res = await dialog.showOpenDialog({
    title: '选择图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
  });
  if (res.canceled || res.filePaths.length === 0) return [];

  const out: MediaAsset[] = [];
  for (const src of res.filePaths) {
    try {
      const ext = extname(src).toLowerCase();
      if (!ALLOWED_EXTS.has(ext)) {
        log.warn(`[assets] skip unsupported ext: ${src}`);
        continue;
      }
      const id = randomUUID();
      const dest = join(assetsDir(), `${id}${ext}`);
      await fs.copyFile(src, dest);
      const stat = await fs.stat(dest);
      const rec = insertRecord({
        id,
        filename: basename(src),
        mime_type: detectMime(ext),
        size: stat.size,
        source_url: null,
        storage_path: dest,
        width: null,
        height: null,
      });
      out.push(rec);
      log.info(`[assets] imported: ${rec.filename} -> ${dest} (${stat.size} bytes)`);
    } catch (e) {
      log.error(`[assets] import failed for ${src}:`, e);
    }
  }
  return out;
}

/** 从 URL 下载 (走 Electron net 走系统代理), 存盘 + 入库. */
export async function importFromUrl(url: string): Promise<MediaAsset> {
  await ensureDir();
  const u = new URL(url);
  const urlExt = extname(u.pathname).toLowerCase();
  const ext = ALLOWED_EXTS.has(urlExt) ? urlExt : '.jpg';
  const id = randomUUID();
  const dest = join(assetsDir(), `${id}${ext}`);

  const resp = await net.fetch(url);
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.writeFile(dest, buf);

  const rec = insertRecord({
    id,
    filename: basename(u.pathname) || `from-url${ext}`,
    mime_type: resp.headers.get('content-type')?.split(';')[0] ?? detectMime(ext),
    size: buf.length,
    source_url: url,
    storage_path: dest,
    width: null,
    height: null,
  });
  log.info(`[assets] imported from URL: ${url} -> ${dest}`);
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
  getDb().prepare(`DELETE FROM media_assets WHERE id = ?`).run(id);
}
