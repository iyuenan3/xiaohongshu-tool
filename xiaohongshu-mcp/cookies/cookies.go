package cookies

import (
	"os"
	"path/filepath"

	"github.com/pkg/errors"
)

type Cookier interface {
	LoadCookies() ([]byte, error)
	SaveCookies(data []byte) error
	DeleteCookies() error
}

type localCookie struct {
	path string
}

func NewLoadCookie(path string) Cookier {
	if path == "" {
		panic("path is required")
	}

	return &localCookie{
		path: path,
	}
}

// LoadCookies 从文件中加载 cookies。
func (c *localCookie) LoadCookies() ([]byte, error) {

	data, err := os.ReadFile(c.path)
	if err != nil {
		return nil, errors.Wrap(err, "failed to read cookies from tmp file")
	}

	return data, nil
}

// SaveCookies 保存 cookies 到文件中。
func (c *localCookie) SaveCookies(data []byte) error {
	return os.WriteFile(c.path, data, 0644)
}

// DeleteCookies 删除 cookies 文件。
func (c *localCookie) DeleteCookies() error {
	if _, err := os.Stat(c.path); os.IsNotExist(err) {
		// 文件不存在，返回 nil（认为已经删除）
		return nil
	}
	return os.Remove(c.path)
}

// GetCookiesFilePath 获取 cookies 文件路径。
//
// 优先级（高→低）:
//  1. XHS_USER_DATA_DIR 环境变量 (Electron 内嵌场景, 由主进程注入)
//     → <XHS_USER_DATA_DIR>/cookies.json
//  2. COOKIES_PATH 环境变量 (历史变量, 完整路径)
//  3. /tmp/cookies.json 已存在 (向后兼容 Docker 老部署)
//  4. ./cookies.json (本地调试 fallback)
func GetCookiesFilePath() string {
	// 优先级 1: Electron 注入的 userData 目录
	if dir := os.Getenv("XHS_USER_DATA_DIR"); dir != "" {
		return filepath.Join(dir, "cookies.json")
	}

	// 优先级 2: 历史环境变量
	if p := os.Getenv("COOKIES_PATH"); p != "" {
		return p
	}

	// 优先级 3: 向后兼容旧 Docker 路径
	tmpDir := os.TempDir()
	oldPath := filepath.Join(tmpDir, "cookies.json")
	if _, err := os.Stat(oldPath); err == nil {
		return oldPath
	}

	// 优先级 4: 当前目录
	return "cookies.json"
}
