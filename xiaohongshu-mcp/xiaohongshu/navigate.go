package xiaohongshu

import (
	"context"
	"fmt"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

type NavigateAction struct {
	page *rod.Page
}

func NewNavigate(page *rod.Page) *NavigateAction {
	return &NavigateAction{page: page}
}

// 注意: Context(ctx) 会替换掉调用方已设的 Timeout, 故这里自带 60s 上限;
// Must* 在超时/取消时 panic, 全部改 error 返回 (同 user_profile.go S1 修复)。
func (n *NavigateAction) ToExplorePage(ctx context.Context) error {
	page := n.page.Context(ctx).Timeout(60 * time.Second)

	if err := page.Navigate("https://www.xiaohongshu.com/explore"); err != nil {
		return fmt.Errorf("导航发现页失败: %w", err)
	}
	if err := page.WaitLoad(); err != nil {
		return fmt.Errorf("等待发现页加载失败: %w", err)
	}
	if _, err := page.Timeout(10 * time.Second).Element(`div#app`); err != nil {
		return fmt.Errorf("发现页未就绪 (div#app 未出现): %w", err)
	}

	return nil
}

func (n *NavigateAction) ToProfilePage(ctx context.Context) error {
	// First navigate to explore page (自带 60s 预算)
	if err := n.ToExplorePage(ctx); err != nil {
		return err
	}

	// 60s 预算从这里起表, 只管本函数自己的步骤; 若在 ToExplorePage 之前创建,
	// 发现页导航会先吃掉预算, 降级期个人主页加载 (实测可达 74s) 只剩 ~40s 必超时
	page := n.page.Context(ctx).Timeout(60 * time.Second)

	if err := page.WaitStable(time.Second); err != nil {
		return fmt.Errorf("等待发现页稳定失败: %w", err)
	}

	// Find and click the "我" channel link in sidebar
	profileLink, err := page.Timeout(10 * time.Second).Element(`div.main-container li.user.side-bar-component a.link-wrapper span.channel`)
	if err != nil {
		return fmt.Errorf("侧边栏「我」入口未找到: %w", err)
	}
	if err := profileLink.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return fmt.Errorf("点击「我」入口失败: %w", err)
	}

	// Wait for navigation to complete
	if err := page.WaitLoad(); err != nil {
		return fmt.Errorf("等待个人主页加载失败: %w", err)
	}

	return nil
}
