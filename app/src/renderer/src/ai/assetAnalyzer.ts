// 用 BYOK vision LLM 分析单张图片, 生成 tags + 描述
import OpenAI from 'openai';
import type { BYOKConfig } from './byok';

const PROMPT = `请分析这张图片, 用 JSON 严格返回:
{"tags": ["短词1", "短词2", ...], "description": "一句话描述"}

要求:
- tags 3-5 个中文短词 (主体/风格/场景/颜色/情绪等任选)
- description 不超过 30 字, 客观描述画面
- 只输出 JSON, 不要其他内容, 不要包 \`\`\` 代码块`;

export interface AssetAnalysis {
  tags: string[];
  description: string;
}

export async function analyzeImage(cfg: BYOKConfig, imageDataUrl: string): Promise<AssetAnalysis> {
  const client = new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    dangerouslyAllowBrowser: true,
  });

  const resp = await client.chat.completions.create({
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });

  const raw = resp.choices?.[0]?.message?.content ?? '';
  return parseAnalysis(raw);
}

function parseAnalysis(raw: string): AssetAnalysis {
  // 去掉 ```json ... ``` 包裹
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    const j = JSON.parse(cleaned);
    const tags = Array.isArray(j.tags)
      ? j.tags.filter((t: unknown) => typeof t === 'string').slice(0, 8)
      : [];
    const description = typeof j.description === 'string' ? j.description.slice(0, 100) : '';
    return { tags, description };
  } catch {
    // 模型没按 JSON 返回, 退化: 全文作为 description, 无 tags
    return { tags: [], description: cleaned.slice(0, 100) };
  }
}
