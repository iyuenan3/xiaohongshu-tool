package main

import (
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

// feed_registry: AI 用短序号 (seq) 引用 feed, 真实的 24 位 id / xsec_token
// 留在 Go 端、不经 LLM 复述, 杜绝 LLM 抄错长 id 导致打开错误笔记。
//
// 每次 list_feeds / search_feeds 整体覆盖映射, 序号总指向最新一批结果;
// 配合客户端 "操作前必须重新 list" 约束, seq 始终对应用户当前看到的列表。

type feedRef struct {
	FeedID    string
	XsecToken string
}

var (
	feedRegMu sync.RWMutex
	feedReg   = map[int]feedRef{}
)

// rememberFeeds 用最近一次 list/search 结果覆盖序号映射 (seq 从 1 开始)。
func rememberFeeds(feeds []xiaohongshu.Feed) {
	feedRegMu.Lock()
	defer feedRegMu.Unlock()
	reg := make(map[int]feedRef, len(feeds))
	for i, f := range feeds {
		reg[i+1] = feedRef{FeedID: f.ID, XsecToken: f.XsecToken}
	}
	feedReg = reg
}

// lookupFeed 按序号查真实 id+token。ok=false 表示序号无效或已过期。
func lookupFeed(seq int) (feedID, xsecToken string, ok bool) {
	feedRegMu.RLock()
	defer feedRegMu.RUnlock()
	ref, ok := feedReg[seq]
	return ref.FeedID, ref.XsecToken, ok
}

// resolveFeed 解析 feed 标识: 优先用 seq 查 registry (LLM 路径, 防抄错长 id),
// 无 seq 时回退到显式 feed_id+xsec_token (workflow 等确定性脚本用, 自包含、不怕
// registry 被并发覆盖)。返回 ok=false 时已写好 HTTP 错误响应, 调用方直接 return。
func resolveFeed(c *gin.Context, seq int, feedID, xsecToken string) (string, string, bool) {
	if seq > 0 {
		id, token, found := lookupFeed(seq)
		if !found {
			respondError(c, http.StatusBadRequest, "INVALID_SEQ",
				"序号无效或已过期, 请先调用 list_feeds 获取最新列表", seq)
			return "", "", false
		}
		return id, token, true
	}
	if feedID != "" && xsecToken != "" {
		return feedID, xsecToken, true
	}
	respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
		"需要提供 seq 或 feed_id+xsec_token", nil)
	return "", "", false
}
