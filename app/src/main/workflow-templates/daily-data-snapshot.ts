// daily_data_snapshot 模板 (M7 P2): 每日账号级数据快照 → data_snapshots 表, 用于增长趋势 + 反馈闭环.
// 数据源: my_profile (/user/me → GetMyProfileViaSidebar) 返回 UserProfileResponse:
//   { userBasicInfo: {nickname, redId}, interactions: [{type:'fans'|'follows'|'interaction', count}], feeds: [...] }
// 经 myProfileHandler respondSuccess(c, {data: result}) 双层包装 → 实际在 body.data.data。

import { getDb } from '../db';
import { parseCount } from '../xhs-count';
import type { Template, ExecHelpers, ExecResult } from './index';

interface UserInteraction {
  type?: string; // follows / fans / interaction(获赞与收藏)
  count?: string;
}
interface MyProfile {
  userBasicInfo?: { nickname?: string; redId?: string };
  interactions?: UserInteraction[];
  feeds?: unknown[];
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
    let prof: MyProfile;
    try {
      const body = (await helpers.callTool('my_profile', {})) as Record<string, unknown>;
      // 双层包装: body.data.data = UserProfileResponse (兼容单层/裸对象兜底)
      const d = body as { data?: { data?: unknown } };
      prof = (d.data?.data ?? d.data ?? body) as MyProfile;
      helpers.log({ step: 'my_profile', result: { nickname: prof.userBasicInfo?.nickname } });
    } catch (e) {
      helpers.log({ step: 'my_profile', error: (e as Error).message });
      throw e;
    }

    const byType = (t: string) => parseCount(prof.interactions?.find((i) => i.type === t)?.count);
    const fans = byType('fans');
    const follows = byType('follows');
    const likesTotal = byType('interaction'); // 获赞与收藏
    const notesCount = Array.isArray(prof.feeds) ? prof.feeds.length : null; // 主页可见笔记数 (近似, 分页可能不全)
    const nickname = prof.userBasicInfo?.nickname ?? null;
    const redId = prof.userBasicInfo?.redId ?? null;

    try {
      getDb()
        .prepare(
          `INSERT INTO data_snapshots (taken_at, red_id, nickname, fans, follows, notes_count, likes_total, raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Date.now(),
          redId,
          nickname,
          fans,
          follows,
          notesCount,
          likesTotal,
          JSON.stringify(prof).slice(0, 4000),
        );
      helpers.log({ step: 'snapshot_saved', result: { fans, follows, notesCount, likesTotal } });
    } catch (e) {
      helpers.log({ step: 'snapshot_saved', error: (e as Error).message });
      throw e;
    }

    const summary = `📊 ${nickname ?? '主页'}: 粉丝 ${fans ?? '?'} · 关注 ${follows ?? '?'} · 笔记 ${notesCount ?? '?'} · 获赞 ${likesTotal ?? '?'}`;
    return { status: 'success', summary };
  },
};
