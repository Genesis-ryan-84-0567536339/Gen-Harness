package ops

import (
	"archive/zip"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
)

// DoctorDeps cho phép tiêm mọi phụ thuộc I/O thật (Docker CLI, TCP, TLS,
// HTTP) khi test — các trường nil dùng cài đặt thật.
type DoctorDeps struct {
	Runner dockercli.Runner
	Client *http.Client
	// DialTCP thử kết nối TCP tới address, trả lỗi nếu không kết nối được
	// trong timeout — nil dùng net.DialTimeout thật.
	DialTCP func(address string, timeout time.Duration) error
	// DialTLS thử bắt tay TLS tới address (InsecureSkipVerify — chỉ kiểm
	// TLS có phục vụ được, không xác minh CA), trả về mô tả chứng chỉ nhận
	// được — nil dùng tls.DialWithDialer thật.
	DialTLS func(address string, timeout time.Duration) (subject string, notAfter time.Time, err error)
}

func realDialTCP(address string, timeout time.Duration) error {
	conn, err := net.DialTimeout("tcp", address, timeout)
	if err != nil {
		return err
	}
	return conn.Close()
}

func realDialTLS(address string, timeout time.Duration) (string, time.Time, error) {
	dialer := &net.Dialer{Timeout: timeout}
	conn, err := tls.DialWithDialer(dialer, "tcp", address, &tls.Config{InsecureSkipVerify: true}) //nolint:gosec // chỉ kiểm TLS phục vụ được, xem DoctorDeps.DialTLS
	if err != nil {
		return "", time.Time{}, err
	}
	defer func() { _ = conn.Close() }()
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return "", time.Time{}, fmt.Errorf("không có chứng chỉ nào được trình ra")
	}
	return certs[0].Subject.String(), certs[0].NotAfter, nil
}

// diagLine là một dòng chẩn đoán: mục kiểm, OK hay không, chi tiết.
type diagLine struct {
	Check string
	OK    bool
	Info  string
}

func (d diagLine) String() string {
	mark := "✓"
	if !d.OK {
		mark = "✕"
	}
	return fmt.Sprintf("%s %-24s %s", mark, d.Check, d.Info)
}

// RunDoctor chẩn đoán runtime/cổng/chứng chỉ/dung lượng/đồng hồ/kết nối
// kênh, in tóm tắt ra out, và xuất báo cáo đầy đủ (report.txt +
// `docker compose logs --tail=500`) vào một tệp zip tại outPath.
func RunDoctor(ctx context.Context, env *Env, outPath string, deps DoctorDeps, out io.Writer) error {
	runner := deps.Runner
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}
	client := deps.Client
	if client == nil {
		client = insecureLocalClient(5 * time.Second)
	}
	dialTCP := deps.DialTCP
	if dialTCP == nil {
		dialTCP = realDialTCP
	}
	dialTLS := deps.DialTLS
	if dialTLS == nil {
		dialTLS = realDialTLS
	}

	var lines []diagLine

	// 1. Runtime: `docker version --format`.
	verOut, verErr := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: []string{"version", "--format", "{{.Server.Version}}"}})
	if verErr != nil {
		lines = append(lines, diagLine{"Docker runtime", false, verErr.Error()})
	} else {
		lines = append(lines, diagLine{"Docker runtime", true, "Docker Engine " + strings.TrimSpace(string(verOut))})
	}

	// 2. Cổng: thử kết nối TCP tới 127.0.0.1:port.
	addr := fmt.Sprintf("127.0.0.1:%d", ResolvePort(env.Port))
	if err := dialTCP(addr, 2*time.Second); err != nil {
		lines = append(lines, diagLine{"Cổng " + addr, false, err.Error()})
	} else {
		lines = append(lines, diagLine{"Cổng " + addr, true, "đang lắng nghe"})
	}

	// 3. Chứng chỉ: bắt tay TLS tới cùng cổng.
	if subject, notAfter, err := dialTLS(addr, 2*time.Second); err != nil {
		lines = append(lines, diagLine{"Chứng chỉ TLS", false, err.Error()})
	} else {
		lines = append(lines, diagLine{"Chứng chỉ TLS", true, fmt.Sprintf("%s (hết hạn %s)", subject, notAfter.Format("2006-01-02"))})
	}

	// 4. Dung lượng: `docker system df -v`, lọc theo volume Gen-Harness.
	dfOut, dfErr := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: []string{"system", "df", "-v"}})
	if dfErr != nil {
		lines = append(lines, diagLine{"Dung lượng", false, dfErr.Error()})
	} else {
		vl := volumeLines(string(dfOut))
		lines = append(lines, diagLine{"Dung lượng", true, fmt.Sprintf("%d dòng volume liên quan (chi tiết trong báo cáo)", len(vl))})
	}

	// 5. Đồng hồ: so time.Now() UTC với header HTTP "Date" của chính
	// /api/v1/ready (nguồn tin cậy có sẵn — mọi phản hồi HTTP chuẩn đều có
	// header Date do chính server đặt, không cần thêm endpoint mới) — nếu
	// gọi /api/v1/ready thất bại (dịch vụ chưa chạy), KHÔNG suy đoán, ghi rõ
	// bỏ qua vì không có nguồn tin cậy nào khác sẵn có.
	readyURL := localURL(env.Port, readyPath)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, readyURL, nil)
	resp, clockErr := client.Do(req)
	switch {
	case clockErr != nil:
		lines = append(lines, diagLine{"Đồng hồ hệ thống", false, "bỏ qua — không gọi được " + readyPath + " để lấy giờ tham chiếu (" + clockErr.Error() + ")"})
	default:
		defer func() { _ = resp.Body.Close() }()
		dateHdr := resp.Header.Get("Date")
		if dateHdr == "" {
			lines = append(lines, diagLine{"Đồng hồ hệ thống", false, "bỏ qua — phản hồi không có header Date"})
		} else if serverTime, perr := http.ParseTime(dateHdr); perr != nil {
			lines = append(lines, diagLine{"Đồng hồ hệ thống", false, "bỏ qua — không phân tích được header Date: " + perr.Error()})
		} else {
			skew := time.Since(serverTime)
			lines = append(lines, diagLine{"Đồng hồ hệ thống", true, fmt.Sprintf("lệch %s so với header Date của %s", skew.Round(time.Second), readyPath)})
		}
	}

	// 6. Kết nối kênh (bridge): đọc lại chính /api/v1/ready ("bridge":
	// "ok"/"down", xem apps/api/gh/shell/routes.py) — bridge không có
	// healthcheck compose riêng nên "ready" là nguồn thật duy nhất hiện có;
	// KHÔNG bịa số liệu nào khác.
	readyBody, readyErr := probeReadyBody(ctx, client, readyURL)
	switch {
	case readyErr != nil:
		lines = append(lines, diagLine{"Kết nối kênh (bridge)", false, "không gọi được " + readyPath + ": " + readyErr.Error()})
	default:
		bridgeStatus := readyBody["bridge"]
		lines = append(lines, diagLine{"Kết nối kênh (bridge)", bridgeStatus == "ok", "bridge: " + bridgeStatus})
	}

	for _, l := range lines {
		_, _ = fmt.Fprintln(out, l.String())
	}

	// Xuất báo cáo zip: report.txt (các dòng trên, đầy đủ) + logs.txt
	// (`docker compose logs --tail=500` mọi service).
	composePath, locErr := env.LocatePath()
	var logsOut []byte
	var logsErr error
	if locErr == nil {
		bundle, secErr := env.LoadSecrets()
		if secErr == nil {
			logsArgs := compose.BaseArgs(composePath, "logs", "--tail=500")
			logsOut, logsErr = runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: logsArgs, Env: EnvOverlay(bundle), Dir: composeDir(composePath)})
		} else {
			logsErr = secErr
		}
	} else {
		logsErr = locErr
	}

	if err := writeDoctorZip(outPath, lines, logsOut, logsErr); err != nil {
		return &OpError{
			Code: ErrCodeDoctorReportFailed,
			What: "Không ghi được báo cáo chẩn đoán ra " + outPath,
			Why:  err.Error(),
			Next: "Kiểm quyền ghi thư mục đích rồi thử lại.",
			Err:  err,
		}
	}
	_, _ = fmt.Fprintln(out, "\nBáo cáo đầy đủ: "+outPath)
	return nil
}

func writeDoctorZip(outPath string, lines []diagLine, logsOut []byte, logsErr error) error {
	if err := os.MkdirAll(mustAbsDir(outPath), 0o755); err != nil {
		return err
	}
	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	zw := zip.NewWriter(f)
	defer func() { _ = zw.Close() }()

	var report strings.Builder
	report.WriteString("Gen-Harness — báo cáo chẩn đoán (genh doctor)\n")
	report.WriteString("Sinh lúc: " + time.Now().UTC().Format(time.RFC3339) + "\n\n")
	for _, l := range lines {
		report.WriteString(l.String() + "\n")
	}

	rw, err := zw.Create("report.txt")
	if err != nil {
		return err
	}
	if _, err := rw.Write([]byte(report.String())); err != nil {
		return err
	}

	lw, err := zw.Create("logs.txt")
	if err != nil {
		return err
	}
	if logsErr != nil {
		if _, err := lw.Write([]byte("không lấy được log: " + logsErr.Error() + "\n")); err != nil {
			return err
		}
	} else if _, err := lw.Write(logsOut); err != nil {
		return err
	}

	return nil
}

// mustAbsDir trả về Dir(path) — nếu path chỉ là tên tệp (không có thư mục
// cha rõ ràng), trả "." để os.MkdirAll không lỗi.
func mustAbsDir(path string) string {
	dir := filepath.Dir(path)
	if dir == "" {
		return "."
	}
	return dir
}
