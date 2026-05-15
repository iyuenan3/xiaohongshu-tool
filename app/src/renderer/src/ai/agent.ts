// Tool Calling Loop. 用 openai-node 直连 LLM, 流式 + tool_calls 累计, 调本地 MCP, 多轮迭代。

import OpenAI from 'openai';
import { ALL_TOOL_SCHEMAS, getHttpBinding, isSensitive, type ToolName } from './tools';
import type { BYOKConfig } from './byok';

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
2. feed_id 和 xsec_token 必须从 list_feeds / search_feeds 的结果中获取, 不可编造
3. 发布内容: 标题 ≤ 20 字, content 不能包含 # 开头的标签, 标签放 tags 参数 (不加 #), 图片 1-9 张
4. 用户要求"批量"或"频繁"操作时, 提醒频率风控 (建议每天发布 ≤ 3 篇, 间隔 ≥ 30 分钟)
5. 一次只调一个工具, 等结果后再继续
6. 对话用中文, 简洁不啰嗦`;

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
  onEvent: (e: AgentEvent) => void;
  onToolCall: ToolCaller;
  onConfirm: ConfirmHandler;
  abortSignal?: AbortSignal;
}

export async function runAgent(opts: RunAgentOptions): Promise<ChatMessage[]> {
  const { cfg, onEvent, onToolCall, onConfirm, abortSignal } = opts;

  const client = new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    dangerouslyAllowBrowser: true,
  });

  const systemPrompt = await buildSystemPrompt();
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...opts.history.map(toOpenAIMessage),
    { role: 'user', content: opts.userInput },
  ];

  // 返回给调用方持久化的轻量历史 (不含 system, 不含 tool_calls 实例对象)
  const newHistory: ChatMessage[] = [...opts.history, { role: 'user', content: opts.userInput }];

  // Loop
  const MAX_ROUNDS = 10;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (abortSignal?.aborted) {
      onEvent({ type: 'error', error: '用户取消' });
      return newHistory;
    }

    let assistantText = '';
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

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
      onEvent({ type: 'error', error: String(e) });
      return newHistory;
    }

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

      // 检查工具是否注册
      if (!getHttpBinding(name)) {
        const err = `工具 ${name} 不存在或未注册`;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: err });
        newHistory.push({ role: 'tool', tool_call_id: tc.id, content: err });
        onEvent({ type: 'tool_result', toolCallId: tc.id, toolError: err });
        continue;
      }

      try {
        const result = await onToolCall(name as ToolName, args);
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
        newHistory.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
        onEvent({ type: 'tool_result', toolCallId: tc.id, toolResult: result });
      } catch (e) {
        const err = `工具调用失败: ${String(e)}`;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: err });
        newHistory.push({ role: 'tool', tool_call_id: tc.id, content: err });
        onEvent({ type: 'tool_result', toolCallId: tc.id, toolError: err });
      }

      onEvent({ type: 'tool_call_done', toolCallId: tc.id });
    }
    // 继续下一轮 (LLM 看到 tool result 后决定是否再调)
  }

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
