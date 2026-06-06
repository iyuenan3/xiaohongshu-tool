// 运营报告 (P2/D): 账号趋势 + 周对比 + 笔记表现榜 + 可选 AI 解读.
// 数据来自 data_snapshots(账号级) + note_snapshots(笔记级), 由「数据快照/笔记数据采集」采集器每日落库.
import { useEffect, useState, type CSSProperties } from 'react';

interface TrendPoint {
  taken_at: number;
  fans: number | null;
  follows: number | null;
  notes_count: number | null;
  likes_total: number | null;
}
interface NotePerf {
  feed_id: string;
  title: string | null;
  liked: number | null;
  collected: number | null;
  comments: number | null;
}

const DAY = 86400000;

export default function OperatingReport() {
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [notePerf, setNotePerf] = useState<NotePerf[]>([]);
  const [insight, setInsight] = useState<string | null>(null);
  const [loadingInsight, setLoadingInsight] = useState(false);

  useEffect(() => {
    void window.api.operating.report().then((r) => {
      setTrend(r.trend ?? []);
      setNotePerf(r.notePerf ?? []);
    });
  }, []);

  const genInsight = async () => {
    setLoadingInsight(true);
    setInsight(null);
    try {
      const r = await window.api.operating.reportInsight();
      setInsight(r.ok ? (r.insight ?? '') : `解读失败：${r.error ?? '未知'}`);
    } finally {
      setLoadingInsight(false);
    }
  };

  if (trend.length === 0 && notePerf.length === 0) {
    return (
      <div style={{ marginTop: 28, borderTop: '1px solid var(--rule)', paddingTop: 20 }}>
        <h3 style={{ margin: 0 }}>运营报告</h3>
        <p style={{ color: 'var(--ink-mute)', fontSize: 13, marginTop: 10 }}>
          暂无数据。激活计划后会自动每日采集账号 + 笔记数据，攒几天再来看趋势与解读。
        </p>
      </div>
    );
  }

  const latest = trend[trend.length - 1];
  // 周对比: 找最接近"最新时间 - 7 天"的快照; 仅当确有 ~7天前数据 (容差 2 天) 才显示, 免得快照都 <7天时误标
  let wowFans: number | null = null;
  let wowLikes: number | null = null;
  let hasWow = false;
  if (latest && trend.length > 1) {
    const target = latest.taken_at - 7 * DAY;
    let prev = trend[0];
    for (const p of trend) if (Math.abs(p.taken_at - target) < Math.abs(prev.taken_at - target)) prev = p;
    if (prev !== latest && Math.abs(prev.taken_at - target) < 2 * DAY) {
      hasWow = true;
      if (latest.fans != null && prev.fans != null) wowFans = latest.fans - prev.fans;
      if (latest.likes_total != null && prev.likes_total != null) wowLikes = latest.likes_total - prev.likes_total;
    }
  }

  const fansMax = Math.max(1, ...trend.map((p) => p.fans ?? 0));
  const noteMax = Math.max(1, ...notePerf.map((n) => n.liked ?? 0));
  const delta = (v: number | null) =>
    v == null ? '' : v > 0 ? ` (+${v})` : v < 0 ? ` (${v})` : ' (持平)';

  return (
    <div style={{ marginTop: 28, borderTop: '1px solid var(--rule)', paddingTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>运营报告</h3>
        <button onClick={genInsight} disabled={loadingInsight} style={btnStyle}>
          {loadingInsight ? 'AI 解读中…' : '✨ AI 解读'}
        </button>
      </div>

      {/* 账号趋势 + 周对比 */}
      {latest && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--ink)' }}>
            粉丝 <b>{latest.fans ?? '?'}</b>
            <span style={{ color: (wowFans ?? 0) >= 0 ? 'var(--green)' : 'var(--accent)', fontSize: 12 }}>{delta(wowFans)}</span>
            <span style={{ color: 'var(--ink-mute)' }}> · 笔记 {latest.notes_count ?? '?'} · 总获赞 </span>
            <b>{latest.likes_total ?? '?'}</b>
            <span style={{ color: (wowLikes ?? 0) >= 0 ? 'var(--green)' : 'var(--accent)', fontSize: 12 }}>{delta(wowLikes)}</span>
            {hasWow && <span style={{ color: 'var(--ink-mute)', fontSize: 11 }}> （对比 7 天前）</span>}
          </div>
          {trend.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 40, marginTop: 8 }} title="粉丝趋势">
              {trend.map((p) => (
                <div
                  key={p.taken_at}
                  style={{
                    flex: 1, minWidth: 2,
                    height: `${Math.round(((p.fans ?? 0) / fansMax) * 100)}%`,
                    background: 'var(--accent-soft)', borderTop: '2px solid var(--accent)',
                  }}
                  title={`${new Date(p.taken_at).toLocaleDateString()}: 粉丝 ${p.fans ?? '?'}`}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* AI 解读 */}
      {insight && (
        <p style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, color: 'var(--ink-soft)', marginTop: 12, padding: '10px 12px', background: 'var(--paper-2)', borderRadius: 6 }}>
          ✨ {insight}
        </p>
      )}

      {/* 笔记表现榜 */}
      {notePerf.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginBottom: 6 }}>笔记表现（按点赞，最近一次采集）</div>
          {notePerf.map((n) => (
            <div key={n.feed_id} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--ink)' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{n.title || '无标题'}</span>
                <span style={{ color: 'var(--ink-mute)', flexShrink: 0 }}>赞 {n.liked ?? '?'} · 藏 {n.collected ?? '?'} · 评 {n.comments ?? '?'}</span>
              </div>
              <div style={{ height: 4, background: 'var(--paper-2)', borderRadius: 2, marginTop: 2 }}>
                <div style={{ height: '100%', width: `${Math.round(((n.liked ?? 0) / noteMax) * 100)}%`, background: 'var(--accent)', borderRadius: 2 }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const btnStyle: CSSProperties = {
  padding: '6px 14px', fontSize: 13, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--rule)', background: 'var(--surface)', color: 'var(--ink-soft)',
};
