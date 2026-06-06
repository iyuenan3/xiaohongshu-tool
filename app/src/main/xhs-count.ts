// 小红书互动计数在页面 __INITIAL_STATE__ 里是字符串: "100" / "1.2万" / "1,234" → number | null
export function parseCount(s?: string | null): number | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  if (/万$/.test(t)) return Math.round(parseFloat(t) * 10000);
  if (/k$/i.test(t)) return Math.round(parseFloat(t) * 1000);
  const n = parseInt(t.replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
