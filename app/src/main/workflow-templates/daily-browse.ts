// daily_browse 模板: 定时浏览养号 (纯浏览, 不点赞不评论).
//   有关键词 → search_feeds 搜垂类; 无关键词 → list_feeds 刷首页推荐.
//   逐条 get_feed_detail (模拟点开看) + 停留, 营造真实浏览轨迹.
// 用途: 自主运营的 browse 行动落地 (养号 / 喂推荐算法), 不触发任何写操作 → 无风控护栏动作.

import type { Template, ExecHelpers, ExecResult } from './index';

interface FeedItem {
  id: string;
  xsecToken?: string;
}

export const dailyBrowse: Template = {
  id: 'daily_browse',
  name: '定时浏览养号',
  emoji: '👀',
  description: '定时刷垂类/首页, 逐条点开停留浏览 (纯看, 不点赞不评论), 用于养号 + 喂推荐算法.',
  paramsSchema: {
    keyword: { type: 'string', default: '', label: '关键词 (空 = 刷首页推荐)' },
    sort: { type: 'enum', options: ['general', 'time_descending', 'popularity_descending'], default: 'general', label: '排序 (综合 / 最新 / 最热, 仅关键词模式)' },
    top_n: { type: 'int', min: 1, max: 20, default: 8, label: '浏览笔记数 (硬上限 20)' },
  },
  async execute(params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    const keyword = String(params.keyword ?? '').trim();
    const sort = (typeof params.sort === 'string' ? params.sort : 'general');
    const top_n = Math.min(Number(params.top_n ?? 8), 20);
    helpers.log({ step: 'start', result: { keyword: keyword || '(首页)', sort, top_n } });

    // 1. 取笔记列表: 有关键词搜垂类, 无关键词刷首页
    let feeds: FeedItem[];
    try {
      const resp = keyword
        ? (await helpers.callTool('search_feeds', { keyword, sort, count: top_n })) as { data?: { feeds?: FeedItem[] }; feeds?: FeedItem[] }
        : (await helpers.callTool('list_feeds', {})) as { data?: { feeds?: FeedItem[] }; feeds?: FeedItem[] };
      feeds = (resp.data?.feeds || resp.feeds || []).slice(0, top_n);
      helpers.log({ step: keyword ? 'search_feeds' : 'list_feeds', result: { count: feeds.length } });
    } catch (e) {
      helpers.log({ step: 'fetch_feeds', error: (e as Error).message });
      throw e; // 拉不到列表整 run 失败
    }
    if (feeds.length === 0) {
      return { status: 'success', summary: keyword ? `👀 关键词「${keyword}」无结果 (跳过)` : '👀 首页无新笔记 (跳过)' };
    }

    // 2. 逐条点开 + 停留浏览 (纯读, 无任何写操作)
    let browsed = 0;
    const skips: string[] = [];
    for (let i = 0; i < feeds.length; i++) {
      const feed = feeds[i];
      const idx = i + 1;
      try {
        await helpers.callTool('get_feed_detail', { feed_id: feed.id, xsec_token: feed.xsecToken });
        browsed++;
        helpers.log({ step: 'view_feed', result: { idx, feed_id: feed.id } });
      } catch (e) {
        const msg = (e as Error).message;
        helpers.log({ step: 'view_feed', error: msg });
        skips.push(`第 ${idx} 条打开失败: ${msg.slice(0, 50)}`);
        continue;
      }
      // 模拟真实阅读停留 (15-45s 随机), 营造自然浏览节奏
      await helpers.sleep(helpers.rand(15000, 45000));
    }

    const isPartial = skips.length > 0 || browsed < feeds.length;
    const label = keyword ? `关键词「${keyword}」` : '首页';
    const summary = isPartial
      ? `⚠️ ${label}浏览 ${browsed} 条${skips.length ? ` (跳过: ${skips.slice(0, 2).join('; ')}${skips.length > 2 ? '...' : ''})` : ''}`
      : `✅ ${label}浏览 ${browsed} 条`;
    return { status: isPartial ? 'partial' : 'success', summary };
  },
};
