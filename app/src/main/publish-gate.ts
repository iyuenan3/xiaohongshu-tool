// 发布闸门 (M4): 待审发布的批准/拒绝。
// 批准 → 走频率护栏 + 选图真实路径 → goProc 真发 → 标记 published。
// 这是「分级自主度」的发布侧: 互动自动, 发布必须用户确认才真正调 publish 工具。

import log from 'electron-log/main';
import type { GoSubprocess } from './go-subprocess';
import { getAssetPath } from './assets';
import { checkRate, logRate } from './rate';
import { getPending, updatePendingStatus } from './operating-db';

export async function approvePublish(
  pendingId: number,
  goProc: GoSubprocess,
): Promise<{ ok: boolean; error?: string }> {
  const p = getPending(pendingId);
  if (!p || p.status !== 'pending') return { ok: false, error: '待审记录不存在或已处理' };
  if (!p.title) return { ok: false, error: '标题为空, 请先编辑' };

  // 频率护栏 (publish 3/天 + 30min gap, 软提示但闸门处硬校验)
  const rate = checkRate('publish');
  if (!rate.allowed) return { ok: false, error: rate.reason ?? '已达发布频率上限' };

  // 素材 id → 本地真实路径 (区分: 从未选图 vs 选的图已被删)
  const imageIds = JSON.parse(p.images || '[]') as string[];
  if (imageIds.length === 0) {
    return { ok: false, error: '此笔记未配图 (生成时素材库无匹配标签), 请补素材后重新生成计划' };
  }
  const imagePaths = imageIds.map((id) => getAssetPath(id)).filter((x): x is string => !!x);
  if (imagePaths.length === 0) {
    return { ok: false, error: '配图素材已被删除, 请重新选图或补素材' };
  }

  try {
    await goProc.callApi('POST', '/api/v1/publish', {
      title: p.title,
      content: p.content ?? '',
      images: imagePaths,
      tags: JSON.parse(p.tags || '[]') as string[],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`[publish-gate] approve publish ${pendingId} failed: ${msg}`);
    return { ok: false, error: `发布失败: ${msg.slice(0, 100)}` };
  }

  logRate('publish');
  updatePendingStatus(pendingId, 'published');
  log.info(`[publish-gate] pending ${pendingId} published`);
  return { ok: true };
}

export function rejectPending(pendingId: number): { ok: boolean } {
  updatePendingStatus(pendingId, 'rejected');
  log.info(`[publish-gate] pending ${pendingId} rejected`);
  return { ok: true };
}
