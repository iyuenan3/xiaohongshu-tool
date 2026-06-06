// 内容方向护栏 (P2/E3): 规则级校验文本是否命中运营画像的禁忌词。
// 用在两处: planned_publish 拟稿时标记(用户审核可见) + publish-gate 批准时硬拦(安全网)。
// 设计见 AIREADME/DESIGN-autonomous-operation.md §8。

import { getActiveProfile } from './operating-db';

// 返回 text 命中的禁忌词列表 (去重, 大小写不敏感)。
// minLen: 只考虑 ≥minLen 字的禁忌词。子串匹配下 1 字词易误杀 (如"广"命中"推广/广州"),
// 故硬拦场景传 minLen=2 防误锁发布; 拟稿标记用默认 1 (全标记给用户看)。
export function findTaboo(text: string, taboo: string[], minLen = 1): string[] {
  if (!text || !taboo?.length) return [];
  const lower = text.toLowerCase();
  const hits = taboo
    .map((w) => w.trim())
    .filter((w) => w.length >= minLen && lower.includes(w.toLowerCase()));
  return [...new Set(hits)];
}

// 读当前 active 画像的禁忌词 (constraints.taboo)。
export function activeTaboo(): string[] {
  try {
    const p = getActiveProfile();
    if (!p) return [];
    const c = JSON.parse(p.constraints || '{}') as { taboo?: string[] };
    return Array.isArray(c.taboo) ? c.taboo : [];
  } catch {
    return [];
  }
}
