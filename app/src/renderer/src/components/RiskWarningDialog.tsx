import { useState } from 'react';

interface Props {
  onAccept: () => void;
  onCancel: () => void;
}

export default function RiskWarningDialog({ onAccept, onCancel }: Props) {
  const [agreed, setAgreed] = useState(false);

  return (
    <div className="settings-overlay">
      <div className="settings-modal risk-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>⚠️ 风控注意</h2>
        </header>
        <div className="settings-body">
          <p>工作流会在你不在电脑前时自动操作你的小红书账号:</p>
          <ul>
            <li>自动点赞 / 评论 / 收藏 (默认弹确认对话框已关)</li>
            <li>自动发布笔记 (定时发布模板)</li>
            <li>调度时间会加 ±10min 随机抖动 + 步骤间 30-90s 随机延迟</li>
            <li>每次执行硬上限: 点赞 ≤ 5, 评论 ≤ 3 (防止 AI 失控)</li>
          </ul>
          <p style={{ marginTop: 12 }}>
            <strong>但仍存在被小红书风控标记的风险, 包括但不限于: 限流 / 临时封禁 / 永久封号。</strong>
          </p>
          <p>使用此功能即表示你了解上述风险, 后果自负。</p>
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 }}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>我已阅读并接受上述风险, 不再提示</span>
          </label>
          <div className="settings-actions">
            <button onClick={onCancel}>取消</button>
            <button className="primary" onClick={onAccept} disabled={!agreed}>接受并启用工作流</button>
          </div>
        </div>
      </div>
    </div>
  );
}
