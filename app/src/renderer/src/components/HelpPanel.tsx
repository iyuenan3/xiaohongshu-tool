export default function HelpPanel() {
  return (
    <div className="help-pane">
      <div className="help-pane__inner">
        <header className="help-hero">
          <h1>小红书<em>自运营系统</em> · 使用指南</h1>
          <p className="lede">本地化 + BYOK · AI 操作 11 个小红书工具</p>
        </header>

        <ol className="help-steps">
          <li>
            <h3>① 配置 AI</h3>
            <p>点击右上角 ⚙️ 设置，填入兼容 OpenAI 格式的 <code>baseURL / API Key / Model</code>。推荐火山方舟 Coding Plan 或 DeepSeek。</p>
          </li>
          <li>
            <h3>② 登录小红书</h3>
            <p>切到「小红书」tab，用 App 扫码登录，登录态自动保存到本地，重启无需再扫。</p>
          </li>
          <li>
            <h3>③ 与 AI 对话</h3>
            <p>回到「控制台」，在右下输入框告诉 AI 你想做什么。例如：</p>
            <ul>
              <li>"搜索露营笔记，按点赞排序显示前 5 条"</li>
              <li>"给最新一条笔记点赞并评论 '太可爱了！'"</li>
              <li>"发布一篇关于咖啡的笔记，标题: …"</li>
            </ul>
          </li>
          <li>
            <h3>④ 常用命令</h3>
            <p>左上 5 个按钮 = 预填到输入框的常用 prompt，点击后可继续编辑再发送，缺参数 AI 会主动追问。</p>
          </li>
          <li>
            <h3>⑤ 安全护栏</h3>
            <p>发布 / 评论 / 点赞 / 收藏 默认弹确认对话框；内置频率限制：发布 ≤ 3/天 + 30min 间隔，评论 ≤ 10/小时，点赞 / 收藏 ≤ 30/小时。</p>
          </li>
        </ol>

        <section className="help-callout help-callout--warn">
          <h4>📌 已知限制</h4>
          <ul>
            <li>仅支持登录 1 个小红书账号 (防风控关联，1 个激活码绑 1 个账号)</li>
            <li>窗口大小固定 1280 × 800 (受 Chromium retina 渲染限制)</li>
            <li>需要 macOS 12+ / Windows 10+ 且能访问外网</li>
          </ul>
        </section>

        <section className="help-callout">
          <h4>💬 联系客服</h4>
          <p>遇到问题或换绑设备，请联系客服（M5 公测前公布渠道，敬请期待）。</p>
        </section>
      </div>
    </div>
  );
}
