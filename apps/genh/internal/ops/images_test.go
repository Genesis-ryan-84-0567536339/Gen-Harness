package ops

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
)

func rmiRefs(fr *fake.Runner) []string {
	var refs []string
	for _, c := range fr.Calls {
		if len(c.Cmd.Args) > 0 && c.Cmd.Args[0] == "rmi" {
			if hasExactArgs(c.Cmd.Args, "-f") || hasExactArgs(c.Cmd.Args, "--force") {
				panic("không bao giờ được rmi -f")
			}
			refs = append(refs, c.Cmd.Args[len(c.Cmd.Args)-1])
		}
	}
	return refs
}

func TestPruneOldImages_KeepsCurrentAndPrevious(t *testing.T) {
	current := ghcrCompose("sha256:a3", "sha256:w3", "sha256:d3")
	previous := ghcrCompose("sha256:a2", "sha256:w2", "sha256:d2")

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: exactArgs("images"), Output: imagesListing(
			"ghcr.io/acme/gen-harness-api\t<none>\tsha256:a3\tid-a3",
			"ghcr.io/acme/gen-harness-api\t<none>\tsha256:a2\tid-a2",
			"ghcr.io/acme/gen-harness-api\t<none>\tsha256:a1\tid-a1",
			"ghcr.io/acme/gen-harness-web\t<none>\tsha256:w3\tid-w3",
			"ghcr.io/acme/gen-harness-web\t<none>\tsha256:w2\tid-w2",
			"ghcr.io/acme/gen-harness-web\t<none>\tsha256:w1\tid-w1",
			"ghcr.io/acme/gen-harness-db\t<none>\tsha256:d3\tid-d3",
			"ghcr.io/acme/gen-harness-db\t<none>\tsha256:d2\tid-d2",
			"ghcr.io/acme/gen-harness-db\t<none>\tsha256:d1\tid-d1",
			// Cùng ID với bản đang giữ nhưng gắn tag — không được xoá.
			"ghcr.io/acme/gen-harness-db\tv0.1.34\tsha256:d3\tid-d3",
			"postgres\t16\tsha256:pg\tid-pg",
			"redis\t7-alpine\tsha256:rd\tid-rd",
			"ghcr.io/x/khac\tlatest\tsha256:kh\tid-kh",
			"ghcr.io/acme/khong-phai-gen-harness\tlatest\tsha256:zz\tid-zz",
		)},
		{Match: exactArgs("rmi"), Output: []byte("")},
	}}

	n, err := pruneOldImages(context.Background(), fr, [][]byte{[]byte(current), []byte(previous)}, &strings.Builder{})
	if err != nil {
		t.Fatalf("pruneOldImages: %v", err)
	}
	got := rmiRefs(fr)
	want := []string{
		"ghcr.io/acme/gen-harness-api@sha256:a1",
		"ghcr.io/acme/gen-harness-web@sha256:w1",
		"ghcr.io/acme/gen-harness-db@sha256:d1",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") || n != 3 {
		t.Errorf("rmi = %v (n=%d), muốn %v", got, n, want)
	}
}

func TestPruneOldImages_TagRefsAndNoneDigest(t *testing.T) {
	keep := []byte("services:\n  api:\n    image: ghcr.io/acme/gen-harness-api:v0.1.34\n")
	fr := &fake.Runner{Responses: []fake.Response{
		{Match: exactArgs("images"), Output: imagesListing(
			"ghcr.io/acme/gen-harness-api\tv0.1.34\t<none>\tid-new",
			"ghcr.io/acme/gen-harness-api\tv0.1.32\t<none>\tid-old",
			"ghcr.io/acme/gen-harness-api\t<none>\t<none>\tid-dangling",
		)},
		{Match: exactArgs("rmi"), Output: []byte("")},
	}}
	if _, err := pruneOldImages(context.Background(), fr, [][]byte{keep}, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	if got := rmiRefs(fr); len(got) != 1 || got[0] != "ghcr.io/acme/gen-harness-api:v0.1.32" {
		t.Errorf("rmi = %v, muốn chỉ tag cũ v0.1.32", got)
	}
}

func TestPruneOldImages_NoGhcrRefsInKeep_DoesNothing(t *testing.T) {
	fr := &fake.Runner{}
	n, err := pruneOldImages(context.Background(), fr, [][]byte{[]byte(updateTestComposeYAML), nil}, &strings.Builder{})
	if err != nil || n != 0 {
		t.Fatalf("muốn 0,nil — được %d,%v", n, err)
	}
	if len(fr.Calls) != 0 {
		t.Errorf("compose build cục bộ (không có ảnh gen-harness) thì không được gọi docker: %+v", fr.Calls)
	}
}

func TestPruneOldImages_RmiErrorContinues(t *testing.T) {
	keep := []byte(ghcrCompose("sha256:a3", "sha256:w3", "sha256:d3"))
	fr := &fake.Runner{Responses: []fake.Response{
		{Match: exactArgs("images"), Output: imagesListing(
			"ghcr.io/acme/gen-harness-api\t<none>\tsha256:a1\tid-a1",
			"ghcr.io/acme/gen-harness-web\t<none>\tsha256:w1\tid-w1",
		)},
		{Match: exactArgs("rmi", "ghcr.io/acme/gen-harness-api@sha256:a1"), Err: errors.New("image is being used by running container")},
		{Match: exactArgs("rmi"), Output: []byte("")},
	}}
	var out strings.Builder
	n, err := pruneOldImages(context.Background(), fr, [][]byte{keep}, &out)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || len(rmiRefs(fr)) != 2 {
		t.Errorf("rmi lỗi phải đi tiếp: n=%d calls=%v", n, rmiRefs(fr))
	}
	if !strings.Contains(out.String(), "không xoá được ảnh ghcr.io/acme/gen-harness-api@sha256:a1") {
		t.Errorf("phải in một dòng khi rmi lỗi: %q", out.String())
	}
}

func TestSplitImageRef(t *testing.T) {
	cases := []struct{ ref, repo, digest, tag string }{
		{"ghcr.io/o/gen-harness-api@sha256:x", "ghcr.io/o/gen-harness-api", "sha256:x", ""},
		{"ghcr.io/o/gen-harness-api:v1", "ghcr.io/o/gen-harness-api", "", "v1"},
		{"ghcr.io/o/gen-harness-api:v1@sha256:x", "ghcr.io/o/gen-harness-api", "sha256:x", "v1"},
		{"ghcr.io/o/gen-harness-api", "ghcr.io/o/gen-harness-api", "", "latest"},
		{"localhost:5000/gen", "localhost:5000/gen", "", "latest"},
	}
	for _, c := range cases {
		r, d, tg := splitImageRef(c.ref)
		if r != c.repo || d != c.digest || tg != c.tag {
			t.Errorf("splitImageRef(%q) = %q,%q,%q", c.ref, r, d, tg)
		}
	}
}
