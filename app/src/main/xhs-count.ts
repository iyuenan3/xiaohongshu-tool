// 小红书互动计数在页面 __INITIAL_STATE__ 里是字符串: "100" / "1.2万" / "1,234" / "10万+" / "1.2k" → number | null
export function parseCount(s?: string | null): number | null {
  if (s == null) return null;
  let t = String(s).trim();
  if (!t) return null;
  t = t.replace(/[+＋]\s*$/, '').replace(/,/g, '').trim(); // 剥尾部 "+" (如 "10万+") 与千分位逗号
  if (!t) return null;
  if (/万/.test(t)) return Math.round(parseFloat(t) * 10000);   // 含"万"即按万 (用 includes 不锚 $, 防残留字符)
  if (/k/i.test(t)) return Math.round(parseFloat(t) * 1000);
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
