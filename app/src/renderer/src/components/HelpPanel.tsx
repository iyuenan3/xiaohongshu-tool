import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

type Props = { devMode?: boolean };

export default function HelpPanel({ devMode }: Props) {
  const [contact, setContact] = useState<string>('');
  useEffect(() => {
    window.api.updater
      .versionInfo()
      .then((v) => { if (v?.support_contact) setContact(v.support_contact); })
      .catch(() => {});
  }, []);

  return (
    <div className="help-pane">
      <div className="help-pane__inner">
        <header className="help-hero">
          <h1>小红书<em>自运营系统</em> · 使用指南</h1>
          <p className="lede">AI 帮你刷小红书 · 浏览 / 互动 / 创作 / 分析 一站搞定</p>
        </header>

        <ol className="help-steps">
          <li>
            <h3>① 登录小红书</h3>
            <p>切到「小红书」tab，用 App 扫码登录。登录态自动保存到本地，重启无需再扫。</p>
          </li>
          <li>
            <h3>② 与 AI 对话</h3>
            <p>回到「控制台」，左侧 5 个常用命令一键发送，或在右下输入框用自然语言告诉 AI 你想做什么。缺参数 AI 会主动追问。</p>
          </li>
        </ol>

        <h2 className="help-section-title">AI 能帮你做什么</h2>

        <section className="help-callout">
          <h4>📖 浏览发现 · 看内容</h4>
          <ul>
            <li>看首页推荐流</li>
            <li>按关键词搜笔记 (可指定排序: 综合 / 最新 / 最热 / 最赞)</li>
            <li>打开某条笔记看完整内容 + 评论 + 互动数据</li>
            <li>查任意用户主页 (头像 / 简介 / 笔记列表)</li>
          </ul>
          <p className="help-eg">
            💡 例: <code>"搜搜露营笔记, 按点赞排前 5 条"</code> · <code>"看 @小张 主页最近笔记"</code> · <code>"打开第 3 条笔记看评论"</code>
          </p>
        </section>

        <section className="help-callout">
          <h4>💬 互动操作 · 经营关系 <small>(默认弹确认 + 频率限制)</small></h4>
          <ul>
            <li>给笔记点赞 / 收藏 — 频率 ≤ 30/小时</li>
            <li>评论笔记 — 频率 ≤ 10/小时</li>
            <li>回复别人评论 — 合并算入评论频率</li>
          </ul>
          <p className="help-eg">
            💡 例: <code>"给这条笔记点赞 + 收藏"</code> · <code>"评论 XX: 拍得真好看!"</code> · <code>"回复 @阿强 的评论: 谢谢支持!"</code>
          </p>
        </section>

        <section className="help-callout">
          <h4>📝 创作发布 · 出内容 <small>(弹确认 + 严格频率)</small></h4>
          <ul>
            <li>发布图文笔记 — 频率 ≤ 3/天 + 30min 最小间隔</li>
            <li>发布视频笔记 — 同上</li>
          </ul>
          <p className="help-eg">
            💡 例: <code>"发图文: 标题《露营装备清单》, 配文 ..., 用素材库里的露营图"</code> · <code>"发视频: 视频 /path/to.mp4, 标题 ..."</code>
          </p>
        </section>

        <section className="help-callout">
          <h4>🔍 实用工具 · 辅助决策</h4>
          <ul>
            <li>查当前登录状态 (哪个账号 / cookies 有效?)</li>
            <li>查自己主页数据 (粉丝 / 获赞 / 笔记数)</li>
            <li>智能搜本地素材库 (AI vision 自动打 tag, 自然语言找图)</li>
            <li>联网搜热点 / 资讯 (辅助选题写稿)</li>
          </ul>
          <p className="help-eg">
            💡 例: <code>"搜本地素材库露营相关图片"</code> · <code>"最近露营装备有什么爆款?"</code>
          </p>
        </section>

        <section className="help-callout help-callout--warn">
          <h4>🛡️ 安全护栏</h4>
          <ul>
            <li>发布 / 评论 / 点赞 / 收藏 默认弹确认对话框</li>
            <li>频率限制: 发布 ≤ 3/天 (30min 间隔), 评论 ≤ 10/小时, 点赞 / 收藏 ≤ 30/小时</li>
            <li>单账号绑定: 1 个激活码绑 1 个小红书账号 (防风控关联)</li>
          </ul>
        </section>

        <section className="help-callout help-callout--warn">
          <h4>📌 已知限制</h4>
          <ul>
            <li>仅支持登录 1 个小红书账号 (换绑请联系客服)</li>
            <li>窗口大小固定 1280 × 800 (受 Chromium retina 渲染限制)</li>
            <li>需要 macOS 12+ / Windows 10+, 国内网络可直连无需 VPN</li>
          </ul>
        </section>

        <section className="help-callout">
          <h4>💬 联系客服</h4>
          {contact && /^https?:\/\//.test(contact) ? (
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ background: '#fff', padding: 10, borderRadius: 8, lineHeight: 0 }}>
                <QRCodeSVG value={contact} size={132} />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <p>微信扫码添加客服 — 遇到问题或换绑设备随时联系。</p>
                <p style={{ fontSize: 12, wordBreak: 'break-all' }}>
                  <a href={contact} target="_blank" rel="noreferrer">{contact}</a>
                </p>
              </div>
            </div>
          ) : (
            <p>{contact || '遇到问题或换绑设备, 请联系客服。'}</p>
          )}
        </section>

        {devMode && (
          <>
            <h2 className="help-section-title">🔧 高级用法 (Dev 模式)</h2>

            <section className="help-callout">
              <h4>🔑 自定义 LLM (BYOK)</h4>
              <p>Settings → 「故障排查 / 反馈」框输入 dev 暗号解锁 → 填 Base URL / API Key / Model。兼容任意 OpenAI 格式 endpoint。</p>
            </section>

            <section className="help-callout">
              <h4>📜 Tool Call Schema (14 个工具)</h4>
              <ul style={{ fontSize: 12, fontFamily: 'Menlo, monospace' }}>
                <li><code>check_login_status()</code> — 是否登录, cookies 有效?</li>
                <li><code>list_feeds()</code> — 首页推荐 feed</li>
                <li><code>search_feeds(keyword, search_sort?, sort_type?)</code> — 按关键词搜笔记</li>
                <li><code>get_feed_detail(feed_id, xsec_token?)</code> — 笔记完整内容 + 评论</li>
                <li><code>user_profile(user_id)</code> — 任意用户主页</li>
                <li><code>my_profile()</code> — 我的主页数据</li>
                <li><code>like_feed(feed_id)</code> — 点赞</li>
                <li><code>favorite_feed(feed_id)</code> — 收藏</li>
                <li><code>post_comment_to_feed(feed_id, content)</code> — 评论</li>
                <li><code>reply_comment_in_feed(feed_id, comment_id, content)</code> — 回复评论</li>
                <li><code>publish_content(title, content, images[])</code> — 发图文 (本地路径)</li>
                <li><code>publish_with_video(title, content, video_path, cover?)</code> — 发视频</li>
                <li><code>search_local_assets(query)</code> — 本地素材库 vision 检索</li>
                <li><code>web_search(query)</code> — 联网搜索 (搜狗)</li>
              </ul>
              <p className="help-eg" style={{ fontSize: 11 }}>
                ChatPanel 里 AI 调用 trace 默认折叠, 点击可展开查看实际 args + 结果。
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
