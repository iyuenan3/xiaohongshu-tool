// 素材自动分析 (主进程): 导入后自动用 vision LLM 打标签写描述, 消除 analyzed=0 盲区。
// 背景 (用户反馈「图文不符」根因之一): 批量导入后不点「补分析」就生成计划, Planner 只见
// 「[无标签] picture-xxx.jpg」→ 编造 asset_tags → 选图匹配不到/乱配。renderer 的手动「补分析」保留,
// 与本模块幂等共存 (双方分析前都查 analyzed, 已分析即跳过)。
// prompt 与 renderer src/renderer/src/ai/assetAnalyzer.ts 保持一致。

import { net, Notification } from 'electron';
import { promises as fs } from 'fs';
import log from 'electron-log/main';
import { licenseManager } from './license';
import { getAsset, setAssetTags, listAssets } from './assets';

const ANALYZE_PROMPT = `请分析这张图片, 用 JSON 严格返回:
{"tags": ["短词1", "短词2", ...], "description": "一句话描述"}

要求:
- tags 3-5 个中文短词 (主体/风格/场景/颜色/情绪等任选)
- description 不超过 30 字, 客观描述画面
- 只输出 JSON, 不要其他内容, 不要包 \`\`\` 代码块`;

const ANALYZE_TIMEOUT_MS = 60 * 1000;
const GAP_MS = 2000; // 串行逐张, 张间歇 2s, 不挤占正常 LLM 通道

const queue: string[] = [];
const queued = new Set<string>();
let draining = false;

/** 导入后调用: 入队自动分析 (去重, 后台串行消化)。 */
export function queueAssetAnalyze(ids: string[]): void {
  for (const id of ids) {
    if (queued.has(id)) continue;
    queued.add(id);
    queue.push(id);
  }
  void drain();
}

/** 启动补扫: 把库里所有 analyzed=0 的存量素材入队 (老版本导入的/上次没分析完的)。 */
export function backfillUnanalyzedAssets(): void {
  const pending = listAssets().filter((a) => a.analyzed !== 1).map((a) => a.id);
  if (!pending.length) return;
  log.info(`[asset-analyze] backfill ${pending.length} unanalyzed asset(s)`);
  // 大批量补扫 (如老用户升级带 69 张未分析) 会持续消耗 AI 额度, 弹通知让用户知情 (不阻塞, 照跑)
  if (pending.length >= 10) {
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: 'xhsPilot · 素材自动分析',
          body: `正在后台为 ${pending.length} 张素材打标签写描述 (AI 从此认得它们)，预计几分钟，会消耗少量 AI 额度`,
        }).show();
      }
    } catch { /* 通知失败不影响分析 */ }
  }
  queueAssetAnalyze(pending);
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  let consecFails = 0;
  try {
    while (queue.length) {
      // LLM 不可用 (未激活/额度) → 停止消化但保留队列, 下次触发 (再导入/重启补扫) 重试
      const llm = await licenseManager.getActiveLlm();
      if (!llm) {
        log.info('[asset-analyze] LLM 未就绪, 暂停自动分析 (剩余队列保留)');
        return;
      }
      const id = queue.shift()!;
      queued.delete(id);
      try {
        await analyzeOne(id, llm.base_url, llm.api_key, llm.model);
        consecFails = 0;
      } catch (e) {
        // 单张失败跳过不重试 (图坏/偶发), 用户仍可手动「补分析」
        log.warn(`[asset-analyze] analyze ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
        // 连败熔断: 3 连败多为系统性原因 (模型不支持 vision / 额度尽), 剩下的全跑只会白烧调用
        if (++consecFails >= 3) {
          log.warn(`[asset-analyze] ${consecFails} consecutive failures, stop auto-analyze (${queue.length} left in queue for next trigger)`);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  } finally {
    draining = false;
  }
}

async function analyzeOne(id: string, baseUrl: string, apiKey: string, model: string): Promise<void> {
  const asset = getAsset(id);
  if (!asset || asset.analyzed === 1) return; // 已删/已被手动补分析
  const buf = await fs.readFile(asset.storage_path);
  const dataUrl = `data:${asset.mime_type || 'image/jpeg'};base64,${buf.toString('base64')}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
  try {
    const resp = await net.fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: ANALYZE_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 300,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
    const json = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = json.choices?.[0]?.message?.content?.trim() ?? '';
    const { tags, description } = parseAnalysis(raw);
    if (!tags.length && !description) throw new Error('输出无法解析为 tags/description');
    setAssetTags(id, tags, description);
    log.info(`[asset-analyze] ${asset.filename} → [${tags.join(',')}] ${description.slice(0, 30)}`);
  } finally {
    clearTimeout(timeout);
  }
}

// 与 renderer assetAnalyzer.ts parseAnalysis 同逻辑
function parseAnalysis(raw: string): { tags: string[]; description: string } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    const j = JSON.parse(cleaned) as { tags?: unknown; description?: unknown };
    const tags = Array.isArray(j.tags)
      ? (j.tags as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 8)
      : [];
    const description = typeof j.description === 'string' ? j.description.slice(0, 100) : '';
    return { tags, description };
  } catch {
    // 模型没按 JSON 返回, 退化: 全文作为 description, 无 tags
    return { tags: [], description: cleaned.slice(0, 100) };
  }
}
