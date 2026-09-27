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

// ProxyHost là tên máy genh dùng để gọi proxy Caddy trên chính máy này.
// PHẢI là "localhost", không phải "127.0.0.1": Caddyfile khai site
// `{$GH_SITE_ADDRESS:localhost}:8443` với `tls internal` — gọi bằng IP thì Go
// không gửi SNI, Caddy không có chứng chỉ cho yêu cầu đó và từ chối bắt tay
// TLS, Host cũng không khớp site (phát hiện ở e2e cài thật: /api/v1/ready
// không bao giờ trả 200 dù api healthy).
const ProxyHost = "localhost"

// localURL dựng "https://localhost:<port><path>".
func localURL(port int, path string) string {
	return fmt.Sprintf("https://%s:%d%s", ProxyHost, ResolvePort(port), path)
}
