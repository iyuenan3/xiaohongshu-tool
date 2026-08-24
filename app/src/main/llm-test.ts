import { net } from 'electron';
import log from 'electron-log/main';
import type { LlmConfig } from './license';

export interface LlmConnectionTestResult {
  ok: boolean;
  message: string;
}

const LLM_TEST_TIMEOUT_MS = 30 * 1000;

export async function testLlmConnection(raw: LlmConfig): Promise<LlmConnectionTestResult> {
  const checked = validateConfig(raw);
  if (!checked.ok) return checked;
  const cfg = checked.config;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TEST_TIMEOUT_MS);

  try {
    const resp = await net.fetch(`${cfg.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'user', content: '调用 connection_test 工具并传入 ok=true，不要输出其他内容。' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'connection_test',
              description: '验证模型是否支持 OpenAI 工具调用',
              parameters: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
                additionalProperties: false,
              },
            },
          },
        ],
        max_tokens: 64,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      log.warn(`[llm-test] connection test failed status=${resp.status}`);
      return { ok: false, message: classifyHttpError(resp.status, detail) };
    }

    const body = await resp.json() as {
      choices?: { message?: { tool_calls?: { function?: { name?: string } }[] } }[];
    };
    const toolCalls = body.choices?.[0]?.message?.tool_calls;
    if (!toolCalls?.some((call) => call.function?.name === 'connection_test')) {
      return {
        ok: false,
        message: '连接和鉴权成功，但模型没有返回工具调用。请选择支持 OpenAI tools 的模型。',
      };
    }

    log.info('[llm-test] connection and tool-call capability verified');
    return { ok: true, message: '连接成功，API Key、模型和工具调用能力均可用。' };
  } catch (e) {
    if (controller.signal.aborted) {
      return { ok: false, message: '连接测试 30 秒超时，请检查网络、Base URL 或模型服务状态。' };
    }
    log.warn(`[llm-test] connection test request failed: ${safeErrorName(e)}`);
    return { ok: false, message: `连接失败：${safeErrorMessage(e)}` };
  } finally {
    clearTimeout(timeout);
  }
}

type ConfigValidation =
  | { ok: true; config: LlmConfig }
  | { ok: false; message: string };

function validateConfig(raw: LlmConfig): ConfigValidation {
  const baseURL = String(raw?.base_url ?? '').trim().replace(/\/+$/, '');
  const apiKey = String(raw?.api_key ?? '').trim();
  const model = String(raw?.model ?? '').trim();
  if (!baseURL || !apiKey || !model) {
    return { ok: false, message: 'Base URL、API Key 和 Model 都不能为空。' };
  }

  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    return { ok: false, message: 'Base URL 格式无效，请填写以 http:// 或 https:// 开头的地址。' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, message: 'Base URL 只支持 http:// 或 https://。' };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, message: 'Base URL 不应包含账号、密码、查询参数或锚点。' };
  }
  if (/\/chat\/completions\/?$/i.test(parsed.pathname)) {
    return { ok: false, message: 'Base URL 请不要包含 /chat/completions，软件会自动补齐该路径。' };
  }

  return {
    ok: true,
    config: { base_url: baseURL, api_key: apiKey, model },
  };
}

function classifyHttpError(status: number, detail: string): string {
  if (status === 401 || status === 403) {
    return '鉴权失败，请检查 API Key 是否正确、有效并属于当前服务。';
  }
  if (status === 404) {
    return '接口或模型不存在，请检查 Base URL 路径和 Model 是否匹配。';
  }
  if (status === 429) {
    return '服务返回 429，请检查额度或稍后重试。';
  }
  if (/UnsupportedModel|model[_ ]?not[_ ]?found/i.test(detail)) {
    return '当前端点不支持该模型，请更换 Model 或使用与模型匹配的 Base URL。';
  }
  // provider 错误正文可能回显请求片段或账号信息，不直接展示或写日志。
  return `服务返回 HTTP ${status}，请检查服务状态和模型配置。`;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 160);
}
