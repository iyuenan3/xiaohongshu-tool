package configs

import "sync"

var (
	useHeadless = true
	binPath     = ""

	// cdpEndpoint 由 main 进程 (Electron) 启动后通过 /internal/attach 注入。
	// 非空表示 attach 模式; 空表示 launcher 模式 (Docker 部署)。
	cdpEndpoint   = ""
	cdpEndpointMu sync.RWMutex
)

func InitHeadless(h bool) {
	useHeadless = h
}

// IsHeadless 是否无头模式。
func IsHeadless() bool {
	return useHeadless
}

func SetBinPath(b string) {
	binPath = b
}

func GetBinPath() string {
	return binPath
}

// SetCDPEndpoint 由 /internal/attach handler 或 CLI --cdp-endpoint 注入。
func SetCDPEndpoint(endpoint string) {
	cdpEndpointMu.Lock()
	defer cdpEndpointMu.Unlock()
	cdpEndpoint = endpoint
}

// GetCDPEndpoint 读取当前 CDP endpoint。空字符串表示 launcher 模式。
func GetCDPEndpoint() string {
	cdpEndpointMu.RLock()
	defer cdpEndpointMu.RUnlock()
	return cdpEndpoint
}
