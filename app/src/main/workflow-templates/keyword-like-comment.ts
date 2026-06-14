// keyword_like_comment 模板: 关键词搜索点赞评论 (M7 P2).
// 跟 daily_like_comment 几乎一致, 把 list_feeds → search_feeds(keyword, sort).

import type { Template, ExecHelpers, ExecResult } from './index';

// 短而真的评论风格 (口语、只点一个细节, 不堆砌/不客套/不 AI 腔), 与 daily_comment 一致
const COMMENT_PROMPTS: Record<string, string> = {
  short: '你在刷小红书随手评一句。≤12 字, 口语, 只蹦一个最有感觉的点 (像「这也太可了」「我直接心动」), 不堆砌不客套。直接返回评论, 不要引号。',
  question: '你在刷小红书随口问一句。≤15 字, 口语真实, 引作者回复 (像「在哪买的呀」「多少钱」), 不客套。直接返回评论, 不要引号。',
  praise: '你在刷小红书真心夸一句。≤15 字, 口语, 只夸一个点 (像「绝了姐妹」「审美在线」), 不堆砌不说套话。直接返回评论, 不要引号。',
};

interface FeedItem {
  id: string;
  xsecToken?: string;
  title?: string;
  desc?: string;
  noteCard?: { displayTitle?: string; desc?: string };
}

export const keywordLikeComment: Template = {
  id: 'keyword_like_comment',
  name: '关键词点赞评论',
  emoji: '🔍',
  description: '按关键词搜笔记, 对前 N 条 (硬上限 5) 点赞 + 部分评论 (硬上限 3), 评论文案由 AI 生成.',
  paramsSchema: {
    keyword: { type: 'string', default: '', label: '关键词 (搜笔记)' },
    sort: { type: 'enum', options: ['general', 'time_descending', 'popularity_descending'], default: 'general', label: '排序 (综合 / 最新 / 最热)' },
    top_n: { type: 'int', min: 1, max: 5, default: 3, label: '点赞数 (硬上限 5 防风控)' },
    comment_n: { type: 'int', min: 0, max: 3, default: 3, label: '评论数 (硬上限 3, 0=只点赞不评论)' },
    comment_style: {
      type: 'enum',
      options: ['short', 'question', 'praise'],
      default: 'praise',
      label: '评论风格',
    },
  },
  async execute(params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    const keyword = String(params.keyword ?? '').trim();
    const sort = (typeof params.sort === 'string' ? params.sort : 'general');
    const top_n = Math.min(Math.max(Number(params.top_n ?? 3), 1), 5);
    // 评论数独立于点赞数: comment_n=0 表示"只点赞不评论" (Planner 的 comment:0 必须被尊重, 否则给唯一账号发了用户没要的评论)
    const comment_n = Math.min(Math.max(Number(params.comment_n ?? 3), 0), 3);
    const comment_style = (typeof params.comment_style === 'string' ? params.comment_style : 'praise') as keyof typeof COMMENT_PROMPTS;

    if (!keyword) {
      return { status: 'partial', summary: '⚠️ 关键词为空, 跳过本次执行 (请编辑工作流填关键词)' };
    }
    helpers.log({ step: 'start', result: { keyword, sort, top_n, comment_n, comment_style } });

    // 1. search_feeds
    let feeds: FeedItem[];
    try {
      const resp = (await helpers.callTool('search_feeds', { keyword, sort, count: top_n })) as { data?: { feeds?: FeedItem[] }; feeds?: FeedItem[] };
      feeds = (resp.data?.feeds || resp.feeds || []).slice(0, top_n);
      helpers.log({ step: 'search_feeds', result: { count: feeds.length } });
    } catch (e) {
      helpers.log({ step: 'search_feeds', error: (e as Error).message });
      throw e;
    }
    if (feeds.length === 0) {
      return { status: 'success', summary: `🔍 关键词「${keyword}」无结果 (跳过)` };
    }

    let liked = 0, commented = 0;
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

      if (commented >= comment_n) continue;
      const title = feed.noteCard?.displayTitle || feed.title || '';
      const desc = feed.noteCard?.desc || feed.desc || '';
      let comment: string;
      try {
        comment = await helpers.callLLM({
          system: COMMENT_PROMPTS[comment_style] ?? COMMENT_PROMPTS.praise,
          user: `笔记标题: ${title}\n笔记内容: ${desc.slice(0, 500)}`,
          max_tokens: 80,
        });
        helpers.log({ step: 'gen_comment', result: { idx, comment } });
      } catch (e) {
        const msg = (e as Error).message;
        helpers.log({ step: 'gen_comment', error: msg });
        skips.push(`第 ${idx} 条评论生成失败: ${msg.slice(0, 50)}`);
        continue;
      }
      try {
        await helpers.callTool('post_comment_to_feed', {
          feed_id: feed.id,
          xsec_token: feed.xsecToken,
          content: comment,
        });
        commented++;
        helpers.log({ step: 'post_comment', result: { idx, feed_id: feed.id } });
      } catch (e) {
        const msg = (e as Error).message;
        helpers.log({ step: 'post_comment', error: msg });
        skips.push(`第 ${idx} 条评论发送失败: ${msg.slice(0, 50)}`);
        continue;
      }
      await helpers.sleep(helpers.rand(30000, 90000));
    }

    const targetComment = Math.min(top_n, comment_n);
    const isPartial = skips.length > 0 || liked < top_n || commented < targetComment;
    const summary = isPartial
      ? `⚠️ 关键词「${keyword}」: 点赞 ${liked} 条 + 评论 ${commented} 条${skips.length ? ` (跳过: ${skips.slice(0, 2).join('; ')}${skips.length > 2 ? '...' : ''})` : ''}`
      : `✅ 关键词「${keyword}」: 点赞 ${liked} 条 + 评论 ${commented} 条`;
    return { status: isPartial ? 'partial' : 'success', summary };
  },
};
