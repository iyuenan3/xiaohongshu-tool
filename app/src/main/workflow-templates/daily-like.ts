// daily_like 模板: 每日首页定时点赞 (从 daily_like_comment 拆出, 纯点赞).

import type { Template, ExecHelpers, ExecResult } from './index';

interface FeedItem {
  id: string;
  xsecToken?: string;
}

export const dailyLike: Template = {
  id: 'daily_like',
  name: '定时点赞',
  emoji: '👍',
  description: '每天定时打开首页推荐, 自动给前 N 条笔记点赞 (纯点赞, 不评论).',
  paramsSchema: {
    top_n: { type: 'int', min: 1, max: 5, default: 3, label: '点赞笔记数 (硬上限 5 防风控)' },
  },
  async execute(params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    const top_n = Math.min(Number(params.top_n ?? 3), 5);
    helpers.log({ step: 'start', result: { top_n } });

    let feeds: FeedItem[];
    try {
      const resp = (await helpers.callTool('list_feeds', {})) as { data?: { feeds?: FeedItem[] }; feeds?: FeedItem[] };
      feeds = (resp.data?.feeds || resp.feeds || []).slice(0, top_n);
      helpers.log({ step: 'list_feeds', result: { count: feeds.length } });
    } catch (e) {
      helpers.log({ step: 'list_feeds', error: (e as Error).message });
      throw e; // 拉不到 feeds 整 run 失败
    }
    if (feeds.length === 0) {
      return { status: 'success', summary: '✅ 首页无新笔记 (跳过)' };
    }

    let liked = 0;
    const skips: string[] = [];
    for (let i = 0; i < feeds.length; i++) {
      const feed = feeds[i];
      const idx = i + 1;
      try {
        await helpers.callTool('like_feed', { feed_id: feed.id, xsec_token: feed.xsecToken });
        liked++;
        helpers.log({ step: 'like_feed', result: { idx, feed_id: feed.id } });
      } catch (e) {
        const msg = (e as Error).message;
        helpers.log({ step: 'like_feed', error: msg });
        skips.push(`第 ${idx} 条点赞失败: ${msg.slice(0, 50)}`);
        continue;
      }
      await helpers.sleep(helpers.rand(30000, 90000));
    }

    const isPartial = skips.length > 0 || liked < top_n;
    const summary = isPartial
      ? `⚠️ 点赞 ${liked} 条${skips.length ? ` (跳过: ${skips.slice(0, 2).join('; ')}${skips.length > 2 ? '...' : ''})` : ''}`
      : `✅ 点赞 ${liked} 条`;
    return { status: isPartial ? 'partial' : 'success', summary };
  },
};
