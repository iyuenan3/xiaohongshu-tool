package main

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"

	"github.com/xpzouying/xiaohongshu-mcp/browser"
	"github.com/xpzouying/xiaohongshu-mcp/configs"
)

// attachCDPRequest 是 /internal/attach 请求体。
type attachCDPRequest struct {
	CDPEndpoint string `json:"cdp_endpoint" binding:"required"`
}

// attachCDPHandler 接受 Electron 主进程注入的 CDP WebSocket endpoint,
// 立即 attach 验证连通, 并注册全局 Browser 单例。后续 MCP 工具调用复用该单例。
//
// 幂等性: 若已注册 attach singleton, 返回成功 (但不重新连接)。这避免主进程重连时
// 重复握手。如果需要切换 endpoint, 需要重启 Go 子进程。
func (s *AppServer) attachCDPHandler(c *gin.Context) {
	var req attachCDPRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, "INVALID_REQUEST",
			"请求参数错误", err.Error())
		return
	}

	if existing := browser.GetAttachedSingleton(); existing != nil {
		logrus.Info("/internal/attach: singleton already registered, skipping")
		respondSuccess(c, gin.H{
			"already_attached": true,
			"endpoint":         configs.GetCDPEndpoint(),
		}, "已 attach, 复用现有连接")
		return
	}

	// 设置配置 (后续 newBrowser() 会读取并走 attach 模式)
	configs.SetCDPEndpoint(req.CDPEndpoint)

	// 立即触发一次 NewBrowser 以验证连通 + 注册单例
	b := browser.NewBrowser(false, browser.WithCDPEndpoint(req.CDPEndpoint))
	if b == nil {
		respondError(c, http.StatusInternalServerError, "ATTACH_FAILED",
			"CDP attach 失败", "browser is nil")
		return
	}

	pages, err := b.Pages()
	if err != nil {
		logrus.Warnf("attach succeeded but Pages() failed: %v", err)
	}
	logrus.Infof("CDP attach 成功, endpoint=%s, 当前 page 数=%d",
		req.CDPEndpoint, len(pages))

	respondSuccess(c, gin.H{
		"endpoint":  req.CDPEndpoint,
		"page_count": len(pages),
	}, "CDP attach 成功")
}
