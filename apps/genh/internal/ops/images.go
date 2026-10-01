package ops

import (
	"context"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
)

// ghImageRepoRe khớp ĐÚNG các repo ảnh của Gen-Harness trên ghcr.io — dọn ảnh
// cũ (F-11) chỉ bao giờ đụng các repo này, không đụng caddy/redis/postgres hay
// ảnh ghcr.io của dự án khác.
var ghImageRepoRe = regexp.MustCompile(`^ghcr\.io/[^/]+/gen-harness-[a-z0-9-]+$`)

// imageRefsFromCompose lấy mọi "image:" không rỗng trong một compose.yaml (lỗi
// cú pháp → không có ref nào).
func imageRefsFromCompose(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	cf, err := compose.Parse(data)
	if err != nil {
		return nil
	}
	var refs []string
	for _, svc := range cf.Services {
		if svc.Image != "" {
			refs = append(refs, svc.Image)
		}
	}
	return refs
}

// splitImageRef tách một ref ảnh thành repo + digest (nếu có "@") hoặc tag.
// "ghcr.io/o/r@sha256:x" → ("ghcr.io/o/r", "sha256:x", ""); "ghcr.io/o/r:v1"
// → ("ghcr.io/o/r", "", "v1"); "ghcr.io/o/r:v1@sha256:x" → digest thắng.
// Không có tag → "latest".
func splitImageRef(ref string) (repo, digest, tag string) {
	name := ref
	if i := strings.Index(name, "@"); i >= 0 {
		digest = name[i+1:]
		name = name[:i]
	}
	slash := strings.LastIndex(name, "/")
	if c := strings.LastIndex(name, ":"); c > slash {
		tag = name[c+1:]
		name = name[:c]
	}
	if digest == "" && tag == "" {
		tag = "latest"
	}
	return name, digest, tag
}

// pruneOldImages dọn ảnh Gen-Harness cũ, GIỮ ảnh của mọi compose trong keep
// (bản hiện tại + bản liền trước). An toàn:
//   - chỉ xét repo khớp ghImageRepoRe VÀ có mặt trong tập giữ (cùng owner/tên);
//   - tập giữ không có ref gen-harness nào (compose dùng build: cục bộ/dev)
//     → không xoá gì;
//   - `docker rmi` KHÔNG -f; ảnh đang dùng (rmi lỗi) chỉ in một dòng rồi bỏ qua.
//
// err chỉ khác nil khi không liệt kê được ảnh.
func pruneOldImages(ctx context.Context, runner dockercli.Runner, keep [][]byte, out io.Writer) (removed int, err error) {
	keepKeys := map[string]bool{}
	for _, data := range keep {
		for _, ref := range imageRefsFromCompose(data) {
			repo, digest, tag := splitImageRef(ref)
			if !ghImageRepoRe.MatchString(repo) {
				continue
			}
			if digest != "" {
				keepKeys[repo+"@"+digest] = true
			} else {
				keepKeys[repo+":"+tag] = true
			}
		}
	}
	if len(keepKeys) == 0 {
		return 0, nil
	}
	// Chỉ dọn trong ĐÚNG các repo (owner/tên) mà bản giữ dùng — không đụng ảnh
	// gen-harness-* của owner khác (bản cài thứ hai dùng chung Docker, bản fork/dev).
	keepRepos := map[string]bool{}
	for k := range keepKeys {
		if i := strings.Index(k, "@"); i >= 0 {
			keepRepos[k[:i]] = true
		} else if i := strings.LastIndex(k, ":"); i >= 0 {
			keepRepos[k[:i]] = true
		}
	}

	listed, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: []string{
		"images", "--digests", "--no-trunc", "--format", "{{.Repository}}\t{{.Tag}}\t{{.Digest}}\t{{.ID}}",
	}})
	if err != nil {
		return 0, fmt.Errorf("liệt kê ảnh Docker: %w", err)
	}

	type row struct{ repo, tag, digest, id string }
	var rows []row
	for _, line := range strings.Split(string(listed), "\n") {
		f := strings.Split(strings.TrimSpace(line), "\t")
		if len(f) < 4 || !ghImageRepoRe.MatchString(f[0]) || !keepRepos[f[0]] {
			continue
		}
		rows = append(rows, row{repo: f[0], tag: f[1], digest: f[2], id: f[3]})
	}

	keepIDs := map[string]bool{}
	for _, r := range rows {
		if (r.digest != "<none>" && keepKeys[r.repo+"@"+r.digest]) || (r.tag != "<none>" && keepKeys[r.repo+":"+r.tag]) {
			keepIDs[r.id] = true
		}
	}

	tried := map[string]bool{}
	for _, r := range rows {
		if keepIDs[r.id] {
			continue
		}
		var ref string
		switch {
		case r.digest != "" && r.digest != "<none>":
			ref = r.repo + "@" + r.digest
		case r.tag != "" && r.tag != "<none>":
			ref = r.repo + ":" + r.tag
		default:
			continue
		}
		if tried[ref] {
			continue
		}
		tried[ref] = true
		if _, rmErr := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: []string{"rmi", ref}}); rmErr != nil {
			_, _ = fmt.Fprintf(out, "     (không xoá được ảnh %s — có thể đang dùng; bỏ qua)\n", ref)
			continue
		}
		removed++
	}
	return removed, nil
}
