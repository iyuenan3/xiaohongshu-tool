package xiaohongshu

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
	"github.com/pkg/errors"
	"github.com/sirupsen/logrus"
	myerrors "github.com/xpzouying/xiaohongshu-mcp/errors"
)

// ActionResult 通用动作响应（点赞/收藏等）
type ActionResult struct {
	FeedID  string `json:"feed_id"`
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// 选择器常量
const (
	SelectorLikeButton    = ".interact-container .left .like-lottie"
	SelectorCollectButton = ".interact-container .left .reds-icon.collect-icon"
)

// interactActionType 交互动作类型
type interactActionType string

const (
	actionLike       interactActionType = "点赞"
	actionFavorite   interactActionType = "收藏"
	actionUnlike     interactActionType = "取消点赞"
	actionUnfavorite interactActionType = "取消收藏"
)

type interactAction struct {
	page *rod.Page
}

func newInteractAction(page *rod.Page) *interactAction {
	return &interactAction{page: page}
}

// preparePage 打开笔记详情页。Must* 在超时/取消时会 panic (真机日志: 页面降级期连环 panic 500),
// 全部改 error 返回, 让上层干净失败。
func (a *interactAction) preparePage(ctx context.Context, actionType interactActionType, feedID, xsecToken string) (*rod.Page, error) {
	page := a.page.Context(ctx).Timeout(60 * time.Second)
	url := makeFeedDetailURL(feedID, xsecToken)
	logrus.Infof("Opening feed detail page for %s: %s", actionType, url)

	if err := page.Navigate(url); err != nil {
		return nil, errors.Wrapf(err, "导航笔记详情页失败 (%s)", actionType)
	}
	if err := page.WaitDOMStable(time.Second, 0); err != nil {
		return nil, errors.Wrapf(err, "等待笔记详情页稳定失败 (%s)", actionType)
	}
	time.Sleep(1 * time.Second)

	return page, nil
}

func (a *interactAction) performClick(page *rod.Page, selector string) error {
	// 限定找按钮最多 10s, 避免选择器失配时死等到 page 的 60s 超时
	element, err := page.Timeout(10 * time.Second).Element(selector)
	if err != nil {
		return errors.Wrapf(err, "找不到按钮 %s", selector)
	}
	if err := element.Click(proto.InputMouseButtonLeft, 1); err != nil {
		return errors.Wrapf(err, "点击按钮 %s 失败", selector)
	}
	return nil
}

// LikeAction 负责处理点赞相关交互
type LikeAction struct {
	*interactAction
}

func NewLikeAction(page *rod.Page) *LikeAction {
	return &LikeAction{interactAction: newInteractAction(page)}
}

// Like 点赞指定笔记，如果已点赞则直接返回
func (a *LikeAction) Like(ctx context.Context, feedID, xsecToken string) error {
	return a.perform(ctx, feedID, xsecToken, true)
}

// Unlike 取消点赞指定笔记，如果未点赞则直接返回
func (a *LikeAction) Unlike(ctx context.Context, feedID, xsecToken string) error {
	return a.perform(ctx, feedID, xsecToken, false)
}

func (a *LikeAction) perform(ctx context.Context, feedID, xsecToken string, targetLiked bool) error {
	actionType := actionLike
	if !targetLiked {
		actionType = actionUnlike
	}

	page, err := a.preparePage(ctx, actionType, feedID, xsecToken)
	if err != nil {
		return err
	}

	liked, _, err := a.getInteractState(page, feedID)
	if err != nil {
		// 详情页没加载到目标笔记 (序号失效/笔记已删/id 不对): 立即失败,
		// 不再硬点 —— 否则后续找不到点赞按钮会死等到超时。
		return errors.Wrapf(err, "笔记详情未加载, 无法%s (feed=%s)", actionType, feedID)
	}

	if targetLiked && liked {
		logrus.Infof("feed %s already liked, skip clicking", feedID)
		return nil
	}
	if !targetLiked && !liked {
		logrus.Infof("feed %s not liked yet, skip clicking", feedID)
		return nil
	}

	return a.toggleLike(page, feedID, targetLiked, actionType)
}

func (a *LikeAction) toggleLike(page *rod.Page, feedID string, targetLiked bool, actionType interactActionType) error {
	if err := a.performClick(page, SelectorLikeButton); err != nil {
		return errors.Wrapf(err, "%s失败 (feed=%s)", actionType, feedID)
	}
	time.Sleep(3 * time.Second)

	liked, _, err := a.getInteractState(page, feedID)
	if err != nil {
		logrus.Warnf("验证%s状态失败: %v", actionType, err)
		return nil
	}
	if liked == targetLiked {
		logrus.Infof("feed %s %s成功", feedID, actionType)
		return nil
	}

	logrus.Warnf("feed %s %s可能未成功，状态未变化，尝试再次点击", feedID, actionType)
	if err := a.performClick(page, SelectorLikeButton); err != nil {
		logrus.Warnf("第二次点击%s失败: %v", actionType, err)
		return nil
	}
	time.Sleep(2 * time.Second)

	liked, _, err = a.getInteractState(page, feedID)
	if err != nil {
		logrus.Warnf("第二次验证%s状态失败: %v", actionType, err)
		return nil
	}
	if liked == targetLiked {
		logrus.Infof("feed %s 第二次点击%s成功", feedID, actionType)
		return nil
	}

	return nil
}

// FavoriteAction 负责处理收藏相关交互
type FavoriteAction struct {
	*interactAction
}

func NewFavoriteAction(page *rod.Page) *FavoriteAction {
	return &FavoriteAction{interactAction: newInteractAction(page)}
}

// Favorite 收藏指定笔记，如果已收藏则直接返回
func (a *FavoriteAction) Favorite(ctx context.Context, feedID, xsecToken string) error {
	return a.perform(ctx, feedID, xsecToken, true)
}

// Unfavorite 取消收藏指定笔记，如果未收藏则直接返回
func (a *FavoriteAction) Unfavorite(ctx context.Context, feedID, xsecToken string) error {
	return a.perform(ctx, feedID, xsecToken, false)
}

func (a *FavoriteAction) perform(ctx context.Context, feedID, xsecToken string, targetCollected bool) error {
	actionType := actionFavorite
	if !targetCollected {
		actionType = actionUnfavorite
	}

	page, err := a.preparePage(ctx, actionType, feedID, xsecToken)
	if err != nil {
		return err
	}

	_, collected, err := a.getInteractState(page, feedID)
	if err != nil {
		// 同 Like: 详情页没加载到目标笔记则立即失败, 不硬点死等。
		return errors.Wrapf(err, "笔记详情未加载, 无法%s (feed=%s)", actionType, feedID)
	}

	if targetCollected && collected {
		logrus.Infof("feed %s already favorited, skip clicking", feedID)
		return nil
	}
	if !targetCollected && !collected {
		logrus.Infof("feed %s not favorited yet, skip clicking", feedID)
		return nil
	}

	return a.toggleFavorite(page, feedID, targetCollected, actionType)
}

func (a *FavoriteAction) toggleFavorite(page *rod.Page, feedID string, targetCollected bool, actionType interactActionType) error {
	if err := a.performClick(page, SelectorCollectButton); err != nil {
		return errors.Wrapf(err, "%s失败 (feed=%s)", actionType, feedID)
	}
	time.Sleep(3 * time.Second)

	_, collected, err := a.getInteractState(page, feedID)
	if err != nil {
		logrus.Warnf("验证%s状态失败: %v", actionType, err)
		return nil
	}
	if collected == targetCollected {
		logrus.Infof("feed %s %s成功", feedID, actionType)
		return nil
	}

	logrus.Warnf("feed %s %s可能未成功，状态未变化，尝试再次点击", feedID, actionType)
	if err := a.performClick(page, SelectorCollectButton); err != nil {
		logrus.Warnf("第二次点击%s失败: %v", actionType, err)
		return nil
	}
	time.Sleep(2 * time.Second)

	_, collected, err = a.getInteractState(page, feedID)
	if err != nil {
		logrus.Warnf("第二次验证%s状态失败: %v", actionType, err)
		return nil
	}
	if collected == targetCollected {
		logrus.Infof("feed %s 第二次点击%s成功", feedID, actionType)
		return nil
	}

	return nil
}

// getInteractState 从 __INITIAL_STATE__ 读取笔记的点赞/收藏状态
func (a *interactAction) getInteractState(page *rod.Page, feedID string) (liked bool, collected bool, err error) {

	obj, err := page.Eval(`() => {
		if (window.__INITIAL_STATE__ &&
		    window.__INITIAL_STATE__.note &&
		    window.__INITIAL_STATE__.note.noteDetailMap) {
			return JSON.stringify(window.__INITIAL_STATE__.note.noteDetailMap);
		}
		return "";
	}`)
	if err != nil {
		return false, false, errors.Wrap(err, "读取 noteDetailMap 失败")
	}
	result := obj.Value.Str()
	if result == "" {
		return false, false, myerrors.ErrNoFeedDetail
	}

	// 直接解析为 noteDetailMap
	var noteDetailMap map[string]struct {
		Note struct {
			InteractInfo struct {
				Liked     bool `json:"liked"`
				Collected bool `json:"collected"`
			} `json:"interactInfo"`
		} `json:"note"`
	}
	if err := json.Unmarshal([]byte(result), &noteDetailMap); err != nil {
		return false, false, errors.Wrap(err, "unmarshal noteDetailMap failed")
	}

	detail, ok := noteDetailMap[feedID]
	if !ok {
		return false, false, fmt.Errorf("feed %s not in noteDetailMap", feedID)
	}
	return detail.Note.InteractInfo.Liked, detail.Note.InteractInfo.Collected, nil
}
