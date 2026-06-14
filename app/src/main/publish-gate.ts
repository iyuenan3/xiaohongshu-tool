// 发布闸门 (M4): 待审发布的批准/拒绝。
// 批准 → 走频率护栏 + 选图真实路径 → goProc 真发 → 标记 published。
// 这是「分级自主度」的发布侧: 互动自动, 发布必须用户确认才真正调 publish 工具。

import log from 'electron-log/main';
import type { GoSubprocess } from './go-subprocess';
import { getAssetPath } from './assets';
import { checkRate, logRate } from './rate';
import {
  getPending, updatePendingStatus, setPublishedFeedId,
  claimPendingForPublish, revertPublishingToPending, rejectPendingIfPending,
} from './operating-db';
import { findTaboo, activeTaboo } from './content-guard';

// 发布失败原因 (P3 自动发扫描据此决定: 转人工 / 顺延重试 / 终止). undefined = 成功。
export type PublishFailReason = 'gone' | 'guardrail' | 'rate' | 'publish_failed' | 'timeout' | 'claimed';
export interface ApproveResult {
  ok: boolean;
  error?: string;
  reason?: PublishFailReason;
}

// P2/A1: 发布成功后从自己主页按标题匹配找出新笔记 id 回写 (best-effort, 失败不影响发布结果).
// publish 工具不返回 note id, 故发后查 my_profile 的 feeds 取标题相符的最新一条。
async function backfillPublishedFeedId(pendingId: number, title: string, goProc: GoSubprocess): Promise<void> {
  try {
    const body = (await goProc.callApi('GET', '/api/v1/user/me')) as { data?: { data?: unknown } };
    const prof = (body?.data?.data ?? body?.data ?? body) as {
      feeds?: Array<{ id?: string; noteCard?: { displayTitle?: string } }>;
    };
    const feeds = Array.isArray(prof?.feeds) ? prof.feeds : [];
    const hit = feeds.find((f) => f.noteCard?.displayTitle?.trim() === title.trim());
    if (hit?.id) {
      setPublishedFeedId(pendingId, hit.id);
      log.info(`[publish-gate] backfilled feed_id ${hit.id} for pending ${pendingId}`);
    } else {
      log.info(`[publish-gate] pending ${pendingId} published, feed_id 暂未匹配到 (笔记可能未即时上墙)`);
    }
  } catch (e) {
    log.warn(`[publish-gate] backfill feed_id failed: ${String(e)}`);
  }
}

export async function approvePublish(
  pendingId: number,
  goProc: GoSubprocess,
): Promise<ApproveResult> {
  const p = getPending(pendingId);
  if (!p || p.status !== 'pending') return { ok: false, error: '待审记录不存在或已处理', reason: 'gone' };
  if (!p.title) return { ok: false, error: '标题为空, 请先编辑', reason: 'guardrail' };

  // E3 内容护栏 (安全网): 标题/正文含画像禁忌词 → 硬拦, 不真发 (minLen=2 防 1 字子串误锁)
  const tabooHits = findTaboo(`${p.title}\n${p.content ?? ''}`, activeTaboo(), 2);
  if (tabooHits.length) {
    return { ok: false, error: `内容含禁忌词[${tabooHits.join('、')}]，请编辑去除后再发`, reason: 'guardrail' };
  }

  // 频率护栏 (publish 3/天 + 30min gap). 注意: rate 类是"暂时不到点", 非永久失败 → reason='rate' (自动发顺延重试)
  const rate = checkRate('publish');
  if (!rate.allowed) return { ok: false, error: rate.reason ?? '已达发布频率上限', reason: 'rate' };

  // 素材 id → 本地真实路径 (区分: 从未选图 vs 选的图已被删)
  const imageIds = JSON.parse(p.images || '[]') as string[];
  if (imageIds.length === 0) {
    return { ok: false, error: '此笔记未配图 (生成时素材库无匹配标签), 请补素材后重新生成计划', reason: 'guardrail' };
  }
  const imagePaths = imageIds.map((id) => getAssetPath(id)).filter((x): x is string => !!x);
  if (imagePaths.length === 0) {
    return { ok: false, error: '配图素材已被删除, 请重新选图或补素材', reason: 'guardrail' };
  }

  // 原子抢占: pending→publishing。抢不到 = 已被并发的扫描/手动确认/拒绝处理 → 不重复真发 (防重复发布)。
  if (!claimPendingForPublish(pendingId)) {
    return { ok: false, error: '该笔记已被处理或正在发布', reason: 'claimed' };
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
    // 超时 = 结果未知 (可能已发出): 不能盲目重试 (会重复发) → 标 timeout, 退回 pending 交上层终止+提醒人工核对。
    // 其它 = 明确失败 (HTTP 错/Go 拒): 退回 pending, 交上层有界重试。
    const isTimeout = msg.includes('超时(240s)') || msg.includes('操作可能未完成');
    revertPublishingToPending(pendingId);
    return { ok: false, error: `发布失败: ${msg.slice(0, 100)}`, reason: isTimeout ? 'timeout' : 'publish_failed' };
  }

  logRate('publish');
  updatePendingStatus(pendingId, 'published');
  log.info(`[publish-gate] pending ${pendingId} published`);
  await backfillPublishedFeedId(pendingId, p.title, goProc); // P2/A1: best-effort 回写 feed_id
  return { ok: true };
}

export function rejectPending(pendingId: number): { ok: boolean; reason?: 'publishing' } {
  // 条件否决: 在途发布 (publishing) 不可撤 → 返回 reason 提示, 不覆盖结果
  const done = rejectPendingIfPending(pendingId);
  if (!done) {
    log.info(`[publish-gate] pending ${pendingId} reject skipped (not pending, likely publishing/decided)`);
    return { ok: false, reason: 'publishing' };
  }
  log.info(`[publish-gate] pending ${pendingId} rejected`);
  return { ok: true };
}
