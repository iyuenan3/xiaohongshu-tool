// daily_comment 模板: 每日首页定时评论 (从 daily_like_comment 拆出, 据内容生成短评论).

import type { Template, ExecHelpers, ExecResult } from './index';

// 短而真的评论风格 (口语、只点一个细节, 不堆砌/不客套/不 AI 腔)
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

export const dailyComment: Template = {
  id: 'daily_comment',
  name: '定时评论',
  emoji: '💬',
  description: '每天定时打开首页推荐, 对前 N 条 (硬上限 3) 笔记按内容生成短评论并发表.',
  paramsSchema: {
    top_n: { type: 'int', min: 1, max: 3, default: 2, label: '评论笔记数 (硬上限 3 防风控)' },
    comment_style: {
      type: 'enum',
      options: ['short', 'question', 'praise'],
      default: 'short',
      label: '评论风格 (短句 / 提问 / 夸赞)',
    },
  },
  async execute(params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    const top_n = Math.min(Number(params.top_n ?? 2), 3);
    const comment_style = (typeof params.comment_style === 'string' ? params.comment_style : 'short') as keyof typeof COMMENT_PROMPTS;
    helpers.log({ step: 'start', result: { top_n, comment_style } });

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

    let commented = 0;
    const skips: string[] = [];
    for (let i = 0; i < feeds.length; i++) {
      const feed = feeds[i];
      const idx = i + 1;
      const title = feed.noteCard?.displayTitle || feed.title || '';
      const desc = feed.noteCard?.desc || feed.desc || '';
      let comment: string;
      try {
        comment = await helpers.callLLM({
          system: COMMENT_PROMPTS[comment_style] ?? COMMENT_PROMPTS.short,
          user: `笔记标题: ${title}\n笔记内容: ${desc.slice(0, 500)}`,
          max_tokens: 60,
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

    const isPartial = skips.length > 0 || commented < top_n;
    const summary = isPartial
      ? `⚠️ 评论 ${commented} 条${skips.length ? ` (跳过: ${skips.slice(0, 2).join('; ')}${skips.length > 2 ? '...' : ''})` : ''}`
      : `✅ 评论 ${commented} 条`;
    return { status: isPartial ? 'partial' : 'success', summary };
  },
};
