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
// cũ (F-11) dọn mọi bản cũ của các repo này. Ảnh NGOÀI (caddy, redis…) chỉ được
// dọn khi compose giữ GHIM DIGEST cho đúng repo đó (xem pruneOldImages); không
// bao giờ đụng postgres hay ảnh ghcr.io của dự án khác.
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

// familiarRepo đưa tên repo Docker Hub về dạng `docker images` in ra:
// "docker.io/library/redis" → "redis", "docker.io/pgvector/pgvector" →
// "pgvector/pgvector". Repo ở registry khác giữ nguyên.
func familiarRepo(repo string) string {
	for _, p := range []string{"docker.io/", "index.docker.io/", "registry-1.docker.io/"} {
		if strings.HasPrefix(repo, p) {
			return strings.TrimPrefix(strings.TrimPrefix(repo, p), "library/")
		}
	}
	return repo
}

// pruneOldImages dọn ảnh cũ, GIỮ ảnh của mọi compose trong keep (bản hiện tại +
// bản liền trước). An toàn:
//   - ảnh Gen-Harness: chỉ xét repo khớp ghImageRepoRe VÀ có mặt trong tập giữ
//     (cùng owner/tên);
//   - ảnh ngoài (caddy, redis… — từ v0.1.48 ghim digest, Renovate nâng digest
//     hằng tuần): chỉ xét repo mà tập giữ GHIM DIGEST, và chỉ dòng KHÔNG gắn tag
//     (kéo theo digest — đúng kiểu genh kéo). Dòng có tag (redis:7-alpine của
//     bản genh cũ kéo theo tag, redis:6 của dự án khác…) không bao giờ đụng;
//   - tập giữ không có ref gen-harness nào (compose dùng build: cục bộ/dev)
//     → không xoá gì, kể cả ảnh ngoài;
//   - `docker rmi` KHÔNG -f; ảnh đang dùng (rmi lỗi — kể cả container đã dừng
//     của dự án khác) chỉ in một dòng rồi bỏ qua.
//
// err chỉ khác nil khi không liệt kê được ảnh.
func pruneOldImages(ctx context.Context, runner dockercli.Runner, keep [][]byte, out io.Writer) (removed int, err error) {
	keepKeys := map[string]bool{}
	ghRepos := map[string]bool{}     // repo gen-harness-* của bản giữ
	pinnedRepos := map[string]bool{} // repo ngoài mà bản giữ ghim digest
	for _, data := range keep {
		for _, ref := range imageRefsFromCompose(data) {
			repo, digest, tag := splitImageRef(ref)
			repo = familiarRepo(repo)
			if ghImageRepoRe.MatchString(repo) {
				ghRepos[repo] = true
			} else if digest != "" {
				pinnedRepos[repo] = true
			}
			if digest != "" {
				keepKeys[repo+"@"+digest] = true
			} else {
				keepKeys[repo+":"+tag] = true
			}
		}
	}
	// Chỉ dọn khi bản giữ là bản cài thật (có ảnh gen-harness) — checkout dev
	// dùng build: cục bộ thì không đụng gì.
	if len(ghRepos) == 0 {
		return 0, nil
	}

	listed, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: []string{
		"images", "--digests", "--no-trunc", "--format", "{{.Repository}}\t{{.Tag}}\t{{.Digest}}\t{{.ID}}",
	}})
	if err != nil {
		return 0, fmt.Errorf("liệt kê ảnh Docker: %w", err)
	}

	type row struct {
		repo, tag, digest, id string
		gh                    bool
	}
	var rows []row
	for _, line := range strings.Split(string(listed), "\n") {
		f := strings.Split(strings.TrimSpace(line), "\t")
		if len(f) < 4 {
			continue
		}
		r := row{repo: familiarRepo(f[0]), tag: f[1], digest: f[2], id: f[3]}
		switch {
		case ghImageRepoRe.MatchString(r.repo):
			// Chỉ dọn trong ĐÚNG các repo (owner/tên) mà bản giữ dùng — không đụng ảnh
			// gen-harness-* của owner khác (bản cài thứ hai dùng chung Docker, bản fork/dev).
			if !ghRepos[r.repo] {
				continue
			}
			r.gh = true
		case pinnedRepos[r.repo]:
		default:
			continue
		}
		rows = append(rows, r)
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
		if !r.gh && r.tag != "" && r.tag != "<none>" {
			continue // ảnh ngoài có tag: có thể của dự án khác — không đụng
		}
		var ref string
		switch {
		case r.digest != "" && r.digest != "<none>":
			ref = r.repo + "@" + r.digest
		case r.gh && r.tag != "" && r.tag != "<none>":
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
