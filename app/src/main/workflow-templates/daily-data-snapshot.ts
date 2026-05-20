// daily_data_snapshot 模板: 每日数据快照 (M7 P2).
// 调 my_profile (/api/v1/user/me) 拿主页数据写 data_snapshots 表, 用于增长趋势追踪.

import { getDb } from '../db';
import type { Template, ExecHelpers, ExecResult } from './index';

interface MyProfileResp {
  // xiaohongshu-mcp service.go UserProfileResponse 字段 (推断, 实际 API 看真实返回 schema)
  user_id?: string;
  red_id?: string;
  nickname?: string;
  interactions?: {
    fans?: number;        // 粉丝
    follows?: number;     // 关注
    interaction?: number; // 获赞与收藏
  };
  notes_total?: number;   // 笔记总数
  [k: string]: unknown;
}

export const dailyDataSnapshot: Template = {
  id: 'daily_data_snapshot',
  name: '每日数据快照',
  emoji: '📊',
  description: '每天定时记录自己主页数据 (粉丝 / 关注 / 笔记数 / 获赞), 用于增长趋势分析.',
  paramsSchema: {
    // 无参数模板, 留空对象
  },
  async execute(_params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    helpers.log({ step: 'start' });
    let me: MyProfileResp;
    try {
      const resp = await helpers.callTool('my_profile', {});
      // HTTP handler 返 {success, data: {...}} 或 直接对象, 兼容两种
      me = ((resp as { data?: MyProfileResp }).data ?? resp) as MyProfileResp;
      helpers.log({ step: 'my_profile', result: { fans: me.interactions?.fans, nickname: me.nickname } });
    } catch (e) {
      helpers.log({ step: 'my_profile', error: (e as Error).message });
      throw e;
    }

    const fans = me.interactions?.fans ?? null;
    const follows = me.interactions?.follows ?? null;
    const likesTotal = me.interactions?.interaction ?? null;
    const notesCount = me.notes_total ?? null;

    try {
      getDb()
        .prepare(
          `INSERT INTO data_snapshots (taken_at, red_id, nickname, fans, follows, notes_count, likes_total, raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Date.now(),
          me.red_id ?? null,
          me.nickname ?? null,
          fans,
          follows,
          notesCount,
          likesTotal,
          JSON.stringify(me).slice(0, 4000),
        );
      helpers.log({ step: 'snapshot_saved', result: { fans, follows, notesCount, likesTotal } });
    } catch (e) {
      helpers.log({ step: 'snapshot_saved', error: (e as Error).message });
      throw e;
    }

    const summary = `📊 ${me.nickname ?? '主页'}: 粉丝 ${fans ?? '?'} · 关注 ${follows ?? '?'} · 笔记 ${notesCount ?? '?'} · 获赞 ${likesTotal ?? '?'}`;
    return { status: 'success', summary };
  },
};
