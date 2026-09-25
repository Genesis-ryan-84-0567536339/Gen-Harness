package ops

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"time"
)

// insecureLocalClient dựng http.Client cho các lệnh vận hành cần gọi
// https://127.0.0.1:<port> (proxy dùng CA nội bộ tự sinh của Caddy, khác CA
// secretgen sinh ở Bước 4 — xem ghi chú dài trong
// internal/install/steps_services.go newInsecureReadyClient, lý do giống hệt
// ở đây: verify đúng đòi trích CA nội bộ Caddy, không cần thiết cho một lệnh
// gọi qua loopback không mang bí mật gì).
func insecureLocalClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // xem ghi chú hàm
		},
	}
}

// localURL dựng "https://127.0.0.1:<port><path>".
func localURL(port int, path string) string {
	return fmt.Sprintf("https://127.0.0.1:%d%s", ResolvePort(port), path)
}
