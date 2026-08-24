package xiaohongshu

import "regexp"

var actionableFeedIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{24}$`)

// IsActionableFeedID 判断卡片是否能进入普通笔记详情链路。
// 搜索流偶尔混入活动、直播等 UUID 风格卡片，直接拼 /explore/<id> 会稳定失败。
func IsActionableFeedID(feedID string) bool {
	return actionableFeedIDPattern.MatchString(feedID)
}

func filterActionableFeeds(feeds []Feed) []Feed {
	filtered := make([]Feed, 0, len(feeds))
	for _, feed := range feeds {
		if IsActionableFeedID(feed.ID) {
			filtered = append(filtered, feed)
		}
	}
	return filtered
}
