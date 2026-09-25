package ops

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
)

func TestRunStop_HappyPath(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("stop"), Output: []byte("")}}}

	var out strings.Builder
	if err := RunStop(context.Background(), env, fr, &out); err != nil {
		t.Fatalf("RunStop: %v", err)
	}
	if len(fr.Calls) != 1 {
		t.Fatalf("Calls = %d, muốn 1", len(fr.Calls))
	}
}

func TestRunStop_Fails_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("stop"), Err: errors.New("boom")}}}

	err := RunStop(context.Background(), env, fr, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeStopFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeStopFailed)
	}
}

func TestRunStart_HappyPath(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("up", "-d"), Output: []byte("")}}}

	var out strings.Builder
	if err := RunStart(context.Background(), env, fr, &out); err != nil {
		t.Fatalf("RunStart: %v", err)
	}
}

func TestRunStart_Fails_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("up", "-d"), Err: errors.New("boom")}}}

	err := RunStart(context.Background(), env, fr, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeStartFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeStartFailed)
	}
}
