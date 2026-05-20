// daily_like_comment 模板: 每日首页点赞评论 (M7 P1).
// 详见 SPEC §13.5.1.

import type { Template, ExecHelpers, ExecResult } from './index';

const COMMENT_PROMPTS: Record<string, string> = {
  short: '你是小红书评论助手. 看完笔记后, 生成 1 条 5-15 字的短评论, 贴合内容, 自然口语. 直接返回评论文字, 不要引号不要前后缀.',
  long: '你是小红书评论助手. 生成 1 条 20-40 字的长评论, 有共鸣感, 不要复读 hashtag. 直接返回评论文字.',
  question: '你是小红书评论助手. 生成 1 条 10-30 字的提问式评论, 引起作者回复. 直接返回评论文字.',
  praise: '你是小红书评论助手. 生成 1 条 10-25 字的真诚赞美评论, 不要假大空套话. 直接返回评论文字.',
};

interface FeedItem {
  id: string;
  xsecToken?: string;
  title?: string;
  desc?: string;
  noteCard?: { displayTitle?: string; desc?: string };
}

export const dailyLikeComment: Template = {
  id: 'daily_like_comment',
  name: '每日点赞评论',
  emoji: '👍',
  description: '每天定时打开首页推荐, 自动给前 N 条笔记点赞, 并用 AI 生成评论文案 (最多 3 条评论).',
  paramsSchema: {
    top_n: { type: 'int', min: 1, max: 5, default: 3, label: '操作笔记数 (硬上限 5 防风控)' },
    comment_style: {
      type: 'enum',
      options: ['short', 'long', 'question', 'praise'],
      default: 'praise',
      label: '评论风格 (短句 / 长句 / 提问 / 赞美)',
    },
  },
  async execute(params: Record<string, unknown>, helpers: ExecHelpers): Promise<ExecResult> {
    const top_n = Math.min(Number(params.top_n ?? 3), 5);
    const comment_style = (typeof params.comment_style === 'string' ? params.comment_style : 'praise') as keyof typeof COMMENT_PROMPTS;
    const COMMENT_HARD_LIMIT = 3;

    helpers.log({ step: 'start', result: { top_n, comment_style } });

    // 1. 拉首页 feeds
    let feeds: FeedItem[];
    try {
      const resp = (await helpers.callTool('list_feeds', {})) as { data?: { feeds?: FeedItem[] }; feeds?: FeedItem[] };
      feeds = (resp.data?.feeds || resp.feeds || []).slice(0, top_n);
      helpers.log({ step: 'list_feeds', result: { count: feeds.length } });
    } catch (e) {
      helpers.log({ step: 'list_feeds', error: (e as Error).message });
      throw e;  // 拉不到 feeds 整 run 失败
    }
    if (feeds.length === 0) {
      return { status: 'success', summary: '✅ 首页无新笔记 (跳过)' };
    }

    let liked = 0;
    let commented = 0;
    const skips: string[] = [];

    for (let i = 0; i < feeds.length; i++) {
      const feed = feeds[i];
      const idx = i + 1;
      // 点赞
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

      // 评论 (上限 3)
      if (commented >= COMMENT_HARD_LIMIT) continue;
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

    const targetComment = Math.min(top_n, COMMENT_HARD_LIMIT);
    const isPartial = skips.length > 0 || liked < top_n || commented < targetComment;
    const summary = isPartial
      ? `⚠️ 点赞 ${liked} 条 + 评论 ${commented} 条${skips.length ? ` (跳过: ${skips.slice(0, 2).join('; ')}${skips.length > 2 ? '...' : ''})` : ''}`
      : `✅ 点赞 ${liked} 条 + 评论 ${commented} 条`;
    return { status: isPartial ? 'partial' : 'success', summary };
  },
};
