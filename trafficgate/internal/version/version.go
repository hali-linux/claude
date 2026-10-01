// Package version 은 빌드 시 -ldflags 로 주입되는 버전 정보를 담는다.
package version

// 빌드 시 다음과 같이 주입된다.
//
//	go build -ldflags "-X github.com/hali-linux/claude/trafficgate/internal/version.Version=1.0.0"
var (
	Version = "dev"
	Commit  = "unknown"
	Date    = "unknown"
)
