package xiaohongshu

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/go-rod/rod"
)

type UserProfileAction struct {
	page *rod.Page
}

func NewUserProfileAction(page *rod.Page) *UserProfileAction {
	pp := page.Timeout(60 * time.Second)
	return &UserProfileAction{page: pp}
}

// UserProfile 获取用户基本信息及帖子
func (u *UserProfileAction) UserProfile(ctx context.Context, userID, xsecToken string) (*UserProfileResponse, error) {
	// Context(ctx) 会覆盖构造时的 60s 超时 → 页面卡死时会一直等到上层 240s 取消,
	// 且 Must* 在取消时 panic (真机日志: user_profile panic + 响应 4m0s)。补回超时 + 全部改 error 返回。
	page := u.page.Context(ctx).Timeout(90 * time.Second)

	searchURL := makeUserProfileURL(userID, xsecToken)
	if err := page.Navigate(searchURL); err != nil {
		return nil, fmt.Errorf("导航用户主页失败: %w", err)
	}
	if err := page.WaitStable(time.Second); err != nil {
		return nil, fmt.Errorf("等待用户主页稳定失败: %w", err)
	}

	return u.extractUserProfileData(page)
}

// extractUserProfileData 从页面中提取用户资料数据的通用方法
func (u *UserProfileAction) extractUserProfileData(page *rod.Page) (*UserProfileResponse, error) {
	if err := page.Wait(rod.Eval(`() => window.__INITIAL_STATE__ !== undefined`)); err != nil {
		return nil, fmt.Errorf("等待 __INITIAL_STATE__ 失败: %w", err)
	}

	userDataObj, err := page.Eval(`() => {
		if (window.__INITIAL_STATE__ &&
		    window.__INITIAL_STATE__.user &&
		    window.__INITIAL_STATE__.user.userPageData) {
			const userPageData = window.__INITIAL_STATE__.user.userPageData;
			const data = userPageData.value !== undefined ? userPageData.value : userPageData._value;
			if (data) {
				return JSON.stringify(data);
			}
		}
		return "";
	}`)
	if err != nil {
		return nil, fmt.Errorf("读取 userPageData 失败: %w", err)
	}
	userDataResult := userDataObj.Value.Str()

	if userDataResult == "" {
		return nil, fmt.Errorf("user.userPageData.value not found in __INITIAL_STATE__")
	}

	// 2. 获取用户帖子：window.__INITIAL_STATE__.user.notes.value
	notesObj, err := page.Eval(`() => {
		if (window.__INITIAL_STATE__ &&
		    window.__INITIAL_STATE__.user &&
		    window.__INITIAL_STATE__.user.notes) {
			const notes = window.__INITIAL_STATE__.user.notes;
			// 优先使用 value（getter），如果不存在则使用 _value（内部字段）
			const data = notes.value !== undefined ? notes.value : notes._value;
			if (data) {
				return JSON.stringify(data);
			}
		}
		return "";
	}`)
	if err != nil {
		return nil, fmt.Errorf("读取 notes 失败: %w", err)
	}
	notesResult := notesObj.Value.Str()

	if notesResult == "" {
		return nil, fmt.Errorf("user.notes.value not found in __INITIAL_STATE__")
	}

	// 解析用户信息
	var userPageData struct {
		Interactions []UserInteractions `json:"interactions"`
		BasicInfo    UserBasicInfo      `json:"basicInfo"`
	}
	if err := json.Unmarshal([]byte(userDataResult), &userPageData); err != nil {
		return nil, fmt.Errorf("failed to unmarshal userPageData: %w", err)
	}

	// 解析帖子数据（帖子为双重数组）
	var notesFeeds [][]Feed
	if err := json.Unmarshal([]byte(notesResult), &notesFeeds); err != nil {
		return nil, fmt.Errorf("failed to unmarshal notes: %w", err)
	}

	// 组装响应
	response := &UserProfileResponse{
		UserBasicInfo: userPageData.BasicInfo,
		Interactions:  userPageData.Interactions,
	}

	// 添加用户帖子（展平双重数组）
	for _, feeds := range notesFeeds {
		if len(feeds) != 0 {
			response.Feeds = append(response.Feeds, feeds...)
		}
	}

	return response, nil
}

func makeUserProfileURL(userID, xsecToken string) string {
	return fmt.Sprintf("https://www.xiaohongshu.com/user/profile/%s?xsec_token=%s&xsec_source=pc_note", userID, xsecToken)
}

func (u *UserProfileAction) GetMyProfileViaSidebar(ctx context.Context) (*UserProfileResponse, error) {
	// 同 UserProfile: 补回被 Context(ctx) 覆盖掉的超时, 避免慢页面拖满上层 240s
	page := u.page.Context(ctx).Timeout(90 * time.Second)

	// 创建导航动作
	navigate := NewNavigate(page)

	// 通过侧边栏导航到个人主页
	if err := navigate.ToProfilePage(ctx); err != nil {
		return nil, fmt.Errorf("failed to navigate to profile page via sidebar: %w", err)
	}

	// 等待页面加载完成并获取 __INITIAL_STATE__
	if err := page.WaitStable(time.Second); err != nil {
		return nil, fmt.Errorf("等待个人主页稳定失败: %w", err)
	}

	return u.extractUserProfileData(page)
}
