interface Command {
  key: string;
  icon: string;
  label: string;
  prompt: string;
}

const COMMANDS: Command[] = [
  { key: 'login', icon: '🔐', label: '检查登录', prompt: '检查一下当前是否已登录小红书' },
  { key: 'publish', icon: '📝', label: '发布笔记', prompt: '我想发布一篇笔记' },
  { key: 'publish-video', icon: '🎬', label: '发布视频', prompt: '我想发布一条视频' },
  { key: 'home', icon: '🏠', label: '获取首页推荐', prompt: '获取首页推荐的笔记' },
  { key: 'search', icon: '🔍', label: '搜索关键词', prompt: '搜索关于 ___ 的笔记' },
];

interface Props {
  onPick: (prompt: string) => void;
  disabled?: boolean;
}

export default function CommandPalette({ onPick, disabled }: Props) {
  return (
    <section className="command-palette">
      <h3 className="pane-heading">常用命令</h3>
      <div className="command-list">
        {COMMANDS.map((c) => (
          <button
            key={c.key}
            className="command-btn"
            onClick={() => onPick(c.prompt)}
            disabled={disabled}
            title={c.prompt}
          >
            <span className="command-btn__icon">{c.icon}</span>
            <span className="command-btn__label">{c.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
