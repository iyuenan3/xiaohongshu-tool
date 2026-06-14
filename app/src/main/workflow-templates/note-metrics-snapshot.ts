// note_metrics_snapshot 模板 (P2 反馈闭环): 采集自己每条笔记的互动数 → note_snapshots 表.
// 数据源: my_profile (/user/me → GetMyProfileViaSidebar) 直接返回自己主页 feeds, 每条带 noteCard.interactInfo
// (likedCount/collectedCount/commentCount/sharedCount)。用于"哪类内容数据好"分析 + 回灌 Planner。纯读, 无写操作。

import { getDb } from '../db';
import { parseCount } from '../xhs-count';
import type { Template, ExecHelpers, ExecResult } from './index';

interface InteractInfo {
  likedCount?: string;
  collectedCount?: string;
  commentCount?: string;
  sharedCount?: string;
}
interface Feed {
  id?: string;
  noteCard?: { displayTitle?: string; interactInfo?: InteractInfo };
}

export const noteMetricsSnapshot: Template = {
  id: 'note_metrics_snapshot',
  name: '笔记数据采集',
  emoji: '📈',
  description: '采集自己每条笔记的点赞/收藏/评论数, 用于反馈闭环 (哪类内容数据好) 回灌 AI 规划. 纯读不互动, 建议每日或每周跑一次.',
  paramsSchema: {
    // 无参数
  },
  async execute(_params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    helpers.log({ step: 'start' });
    let feeds: Feed[];
    let nickname = '';
    try {
      const body = (await helpers.callTool('my_profile', {})) as Record<string, unknown>;
      // myProfileHandler: respondSuccess(c, {data: result}) → body.data.data = UserProfileResponse {userBasicInfo, interactions, feeds}
      const d = body as { data?: { data?: unknown } };
      const prof = (d.data?.data ?? d.data ?? body) as { feeds?: Feed[]; userBasicInfo?: { nickname?: string } };
      feeds = Array.isArray(prof?.feeds) ? prof.feeds : [];
      nickname = prof?.userBasicInfo?.nickname ?? '';
      helpers.log({ step: 'my_profile', result: { nickname, noteCount: feeds.length } });
    } catch (e) {
      helpers.log({ step: 'my_profile', error: (e as Error).message });
      // 瞬时失败返 partial 不 throw: 否则累计 fail_count, 连续 3 次会被自动停用 → 反馈闭环静默断裂
      return { status: 'partial', summary: '📈 本次未取到主页 (登录过期/页面波动?), 跳过本次采集' };
    }

    if (feeds.length === 0) {
      // 主页无笔记 / 数据结构变动 / own-profile 取数异常 → 优雅降级, 不崩
      return { status: 'partial', summary: '📈 未取到自己的笔记 (主页无笔记 / 数据结构变动?), 本次未采集' };
    }

    const takenAt = Date.now();
    const stmt = getDb().prepare(
      `INSERT INTO note_snapshots (taken_at, feed_id, title, liked, collected, comments, shared, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let saved = 0;
    for (const f of feeds) {
      const id = f.id;
      if (!id) continue;
      const ii = f.noteCard?.interactInfo ?? {};
      try {
        stmt.run(
          takenAt,
          id,
          f.noteCard?.displayTitle ?? null,
          parseCount(ii.likedCount),
          parseCount(ii.collectedCount),
          parseCount(ii.commentCount),
          parseCount(ii.sharedCount),
          JSON.stringify(f).slice(0, 2000),
        );
        saved++;
      } catch (e) {
        helpers.log({ step: 'save_note', error: (e as Error).message });
      }
    }
    helpers.log({ step: 'snapshot_saved', result: { saved } });
    return { status: 'success', summary: `📈 ${nickname || '主页'}: 采集 ${saved} 条笔记互动数据` };
  },
};
