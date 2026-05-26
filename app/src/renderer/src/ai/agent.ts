// Tool Calling Loop. 用 openai-node 直连 LLM, 流式 + tool_calls 累计, 调本地 MCP, 多轮迭代。

import OpenAI from 'openai';
import { ALL_TOOL_SCHEMAS, isRegisteredTool, isSensitive, type ToolName } from './tools';
import type { BYOKConfig } from './byok';
import { rlog, safeJson } from '../lib/log';

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface AgentEvent {
  type: 'text_delta' | 'tool_call_start' | 'tool_call_done' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string; // JSON string
  toolResult?: unknown;
  toolError?: string;
  error?: string;
}

const SYSTEM_PROMPT_BASE = `你是小红书内容创作与运营助手, 通过 11 个工具帮助用户完成: 搜索/浏览/读取/点赞/收藏/评论/发布等操作。

关键约束:
1. 操作前先调 check_login_status 确认已登录
2. 点赞/收藏/评论/看详情用 seq(序号) 引用笔记, seq 来自 list_feeds / search_feeds 的返回结果。⚠️ seq 只在「最近一次 list/search」内有效: 用户随时可能刷新页面、推荐流也一直在变, 所以每次要操作笔记前必须先重新调 list_feeds 或 search_feeds 拿最新序号再操作, 绝不使用之前轮次 / 历史消息里出现过的旧序号 (那会指向已经变化的列表)
3. 发布内容: 标题 ≤ 20 字, content 不能包含 # 开头的标签, 标签放 tags 参数 (不加 #), 图片 1-9 张
4. 用户要求"批量"或"频繁"操作时, 提醒频率风控 (建议每天发布 ≤ 3 篇, 间隔 ≥ 30 分钟)
5. 一次只调一个工具, 等结果后再继续
6. 对话用中文, 简洁不啰嗦
7. 写评论/回复 (post_comment / reply_comment) 务必短而真: 默认 ≤15 字、口语、只挑一个最有感觉的点说; 不堆卖点 / 不排比长句 / 不面面俱到 / 不凹"什么时候上架"这类客套, emoji ≤1 (多数时候不用)。学真人随口一句 (像「我猫看了想冲😹」「这个多少钱啊」「配色绝了」), 别写又长又全、热情过头的 AI 腔。

工具选择提示:
- 用户问"现在/最近 X 是什么" / "查一下 Y" / 不确定的事实 / 创作素材时, 优先用 web_search 搜全网 (免费, 国内直连)
- 发图文笔记但用户没明确给图片路径时, 用 search_local_assets 从素材库找候选
- 浏览/操作小红书内容时, 用 list_feeds / search_feeds / get_feed_detail 等小红书工具`;

async function buildSystemPrompt(): Promise<string> {
  let prompt = SYSTEM_PROMPT_BASE;
  try {
    const ctx = await window.api.getPageContext();
    if (ctx && ctx.url) {
      prompt +=
        `\n\n[当前小红书窗口上下文]\n` +
        `URL: ${ctx.url}\n` +
        `标题: ${ctx.title}\n` +
        (ctx.text ? `页面摘要 (前 800 字):\n${ctx.text.slice(0, 800)}\n` : '');
    }
  } catch {
    // ignore
  }
  return prompt;
}

const RATE_ACTION_MAP: Record<string, 'publish' | 'comment' | 'like' | 'favorite'> = {
  publish_content: 'publish',
  publish_with_video: 'publish',
  post_comment_to_feed: 'comment',
  reply_comment_in_feed: 'comment',
  like_feed: 'like',
  favorite_feed: 'favorite',
};

export interface ConfirmHandler {
  (info: { name: string; args: unknown }): Promise<boolean>;
}

export interface ToolCaller {
  (name: string, args: unknown): Promise<unknown>;
}

export interface RunAgentOptions {
  cfg: BYOKConfig;
  history: ChatMessage[];
  userInput: string;
  /**
   * 仅本轮: 附加图片 base64 data URL (例如 "data:image/jpeg;base64,...").
   * 用 OpenAI vision multi-part user content 传给 LLM. 不进入 history (避免持久化爆量,
   * 后续轮 LLM 通过 assistant 之前的文字回复保留对图的理解).
   */
  userImageDataUrls?: string[];
  onEvent: (e: AgentEvent) => void;
  onToolCall: ToolCaller;
  onConfirm: ConfirmHandler;
  abortSignal?: AbortSignal;
}

export async function runAgent(opts: RunAgentOptions): Promise<ChatMessage[]> {
  const { cfg, onEvent, onToolCall, onConfirm, abortSignal } = opts;

  // 内测期间: 进入 runAgent 时记录 LLM 调用上下文 (不含 key)
  rlog.info(
    'agent',
    `runAgent start: model=${cfg.model} baseURL=${cfg.baseURL} historyLen=${opts.history.length} ` +
    `userInputLen=${opts.userInput.length} images=${opts.userImageDataUrls?.length ?? 0}`,
  );
  rlog.info('agent', `user input: ${safeJson(opts.userInput, 400)}`);

  const client = new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    dangerouslyAllowBrowser: true,
  });

  const systemPrompt = await buildSystemPrompt();
  // 本轮 user message: 含图时用 multi-part array (text + image_url), 否则纯字符串
  const imageUrls = opts.userImageDataUrls ?? [];
  const userMessageForLLM: OpenAI.Chat.Completions.ChatCompletionMessageParam = imageUrls.length > 0
    ? {
        role: 'user',
        content: [
          { type: 'text', text: opts.userInput },
          ...imageUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      }
    : { role: 'user', content: opts.userInput };

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...opts.history.map(toOpenAIMessage),
    userMessageForLLM,
  ];

  // 返回给调用方持久化的轻量历史: user 消息仅存文字 (图不入 history 避免持久化爆)
  const newHistory: ChatMessage[] = [...opts.history, { role: 'user', content: opts.userInput }];

  // Loop
  const MAX_ROUNDS = 10;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (abortSignal?.aborted) {
      onEvent({ type: 'error', error: '用户取消' });
      rlog.warn('agent', `aborted at round ${round}`);
      return newHistory;
    }

    let assistantText = '';
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

    rlog.info('agent', `round ${round} start: messages=${messages.length}`);

    try {
      const stream = await client.chat.completions.create({
        model: cfg.model,
        messages,
        tools: ALL_TOOL_SCHEMAS,
        stream: true,
      });

      for await (const chunk of stream) {
        if (abortSignal?.aborted) break;
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          assistantText += delta.content;
          onEvent({ type: 'text_delta', text: delta.content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id ?? '',
                type: 'function',
                function: { name: '', arguments: '' },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            const target = toolCalls[idx] as any;
            if ((tc as any).function?.name) target.function.name += (tc as any).function.name;
            if ((tc as any).function?.arguments) target.function.arguments += (tc as any).function.arguments;
          }
        }
      }
    } catch (e) {
      rlog.error('agent', `LLM stream failed at round ${round}: ${safeJson(e)}`);
      // v0.6 D6: 分场景 catch
      const err = e as { status?: number; error?: { code?: string }; message?: string };
      const status = err?.status;
      const code = err?.error?.code;
      let userMsg = String(e);
      if (code === 'insufficient_quota' || status === 429) {
        userMsg = '本月 AI 调用额度已用完, 下月 1 日 00:00 自动重置. 急需使用请联系客服微信 xxx 临时加额.';
      } else if (status === 401 || status === 403) {
        // 可能是 suspend (token disabled) / api_key 真坏 / 网络异常等. heartbeat 一次同步 status
        try {
          const hb = await window.api.license.heartbeat();
          if (hb.status === 'suspended') {
            userMsg = 'AI 服务已暂停, 请联系客服续费 LLM 服务, 续费后立即恢复.';
          } else if (hb.status === 'revoked') {
            userMsg = '软件已停用, 如有疑问请联系客服微信 xxx.';
          } else {
            userMsg = 'AI 服务连接失败 (401/403), 请稍后重试或联系客服反馈.';
          }
        } catch {
          userMsg = 'AI 服务连接失败 (401/403), 请稍后重试或联系客服反馈.';
        }
      }
      onEvent({ type: 'error', error: userMsg });
      return newHistory;
    }

    rlog.info(
      'agent',
      `round ${round} stream done: text_len=${assistantText.length} tool_calls=${toolCalls.length} ` +
      (toolCalls.length > 0
        ? `tools=[${toolCalls.map((tc) => (tc as any).function?.name ?? '?').join(',')}]`
        : `text_preview="${assistantText.slice(0, 120)}"`),
    );

    // 拼出本轮 assistant message
    const assistantMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
      role: 'assistant',
      content: assistantText || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    messages.push(assistantMsg);
    newHistory.push({
      role: 'assistant',
      content: assistantText,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });

    if (toolCalls.length === 0) {
      rlog.info('agent', `done at round ${round}, final reply preview="${assistantText.slice(0, 200)}"`);
      onEvent({ type: 'done' });
      return newHistory;
    }

    // 执行 tool calls
    for (const tc of toolCalls) {
      const fn = (tc as any).function;
      const name = fn?.name as string;
      const argsRaw = (fn?.arguments as string) || '{}';
      let args: unknown;
      try {
        args = JSON.parse(argsRaw);
      } catch {
        args = {};
      }

      rlog.info('agent', `tool_call: name=${name} args=${safeJson(args, 300)}`);
      onEvent({ type: 'tool_call_start', toolCallId: tc.id, toolName: name, toolArgs: argsRaw });

      // 敏感操作弹确认 + 频率护栏 (软提示)
      if (isSensitive(name)) {
        const rateAction = RATE_ACTION_MAP[name];
        let rateWarn = '';
        if (rateAction) {
          try {
            const chk = await window.api.rate.check(rateAction);
            if (!chk.allowed) {
              rateWarn = `\n\n⚠️ 频率护栏: ${chk.reason ?? '已超额'}`;
            }
          } catch {
            // ignore
          }
        }
        const ok = await onConfirm({
          name: rateWarn ? `${name}${rateWarn}` : name,
          args,
        });
        if (!ok) {
          const refused = '用户拒绝此操作';
          rlog.info('agent', `tool_call: name=${name} → user refused`);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: refused });
          newHistory.push({ role: 'tool', tool_call_id: tc.id, content: refused });
          onEvent({ type: 'tool_result', toolCallId: tc.id, toolError: refused });
          continue;
        }
        // 用户确认通过, 记录频率
        if (rateAction) {
          try {
            await window.api.rate.log(rateAction);
          } catch {
            // ignore
          }
        }
      }

      // 检查工具是否注册 (含本地 local tool)
      if (!isRegisteredTool(name)) {
        const err = `工具 ${name} 不存在或未注册`;
        rlog.warn('agent', `tool_call: name=${name} → unregistered`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: err });
        newHistory.push({ role: 'tool', tool_call_id: tc.id, content: err });
        onEvent({ type: 'tool_result', toolCallId: tc.id, toolError: err });
        continue;
      }

      const callStart = Date.now();
      try {
        const result = await onToolCall(name as ToolName, args);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const dur = Date.now() - callStart;
        rlog.info('agent', `tool_result: name=${name} ok dur=${dur}ms preview=${safeJson(result, 300)}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
        newHistory.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
        onEvent({ type: 'tool_result', toolCallId: tc.id, toolResult: result });
      } catch (e) {
        const err = `工具调用失败: ${String(e)}`;
        const dur = Date.now() - callStart;
        rlog.error('agent', `tool_result: name=${name} FAIL dur=${dur}ms err=${safeJson(e, 400)}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: err });
        newHistory.push({ role: 'tool', tool_call_id: tc.id, content: err });
        onEvent({ type: 'tool_result', toolCallId: tc.id, toolError: err });
      }

      onEvent({ type: 'tool_call_done', toolCallId: tc.id });
    }
    // 继续下一轮 (LLM 看到 tool result 后决定是否再调)
  }

  rlog.warn('agent', `max rounds (${MAX_ROUNDS}) reached, terminating`);
  onEvent({ type: 'error', error: `超过最大对话轮数 (${MAX_ROUNDS}), 已终止` });
  return newHistory;
}

function toOpenAIMessage(m: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.tool_calls,
    };
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  }
  return { role: m.role, content: m.content };
}
