package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// isNotificationLine implements the rule notify.go documents for every client: a line with no
// "id" member is not an answer to anything. Shared by this package's serve harnesses (runLines,
// serveSession), so what they skip is the contract rather than a hard-coded readiness line.
func isNotificationLine(line []byte) bool {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(line, &probe); err != nil {
		return false
	}
	_, hasID := probe["id"]
	return !hasID
}

// serveOutputLines runs one serve session over the given request lines and returns every output
// line, notifications included -- the opposite of runLines, which filters them out.
func serveOutputLines(t *testing.T, opts serveOptions, lines ...string) []map[string]any {
	t.Helper()
	in := strings.NewReader(strings.Join(lines, "\n") + "\n")
	var out bytes.Buffer
	if err := runServeOptions(in, &out, opts); err != nil {
		t.Fatalf("runServeOptions: %v", err)
	}
	var parsed []map[string]any
	scanner := bufio.NewScanner(&out)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		var m map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			t.Fatalf("output line is not valid JSON: %s: %v", scanner.Text(), err)
		}
		parsed = append(parsed, m)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scanning output: %v", err)
	}
	return parsed
}

// TestServe_ReadinessLineIsFirst is the whole point of the readiness line: a host that spawned
// this process has to be able to tell "starting" from "hung" BEFORE it sends anything.
func TestServe_ReadinessLineIsFirst(t *testing.T) {
	lines := serveOutputLines(t, serveOptions{}, `{"id":1,"method":"types"}`)
	if len(lines) < 2 {
		t.Fatalf("got %d output lines, want a readiness line and a response", len(lines))
	}
	ready := lines[0]
	if ready["notification"] != "ready" {
		t.Errorf("first line = %v, want the readiness notification", ready)
	}
	if ready["ready"] != true {
		t.Errorf("readiness line = %v, want ready:true", ready)
	}
	if v, ok := ready["version"].(string); !ok || v == "" {
		t.Errorf("readiness line = %v, want a non-empty version", ready)
	}
	if pid, ok := ready["pid"].(float64); !ok || int(pid) != os.Getpid() {
		t.Errorf("readiness line pid = %v, want this process (%d)", ready["pid"], os.Getpid())
	}
}

// TestServe_NotificationsCannotBreakAnIDCorrelatingClient is the compatibility assertion the
// readiness line has to earn: a client that reads line-delimited JSON and matches responses by
// id must never match one of these, and must never see a line that has an id but neither a
// result nor an error.
func TestServe_NotificationsCannotBreakAnIDCorrelatingClient(t *testing.T) {
	lines := serveOutputLines(t, serveOptions{},
		`{"id":1,"method":"types"}`,
		`{"id":2,"method":"environments"}`)
	responses := 0
	for _, line := range lines {
		_, hasID := line["id"]
		_, hasKind := line["notification"]
		switch {
		case hasKind:
			if hasID {
				t.Errorf("notification %v carries an \"id\" -- an id-correlating client would match it to a request", line)
			}
			if _, has := line["result"]; has {
				t.Errorf("notification %v carries a \"result\"", line)
			}
			if _, has := line["error"]; has {
				t.Errorf("notification %v carries an \"error\"", line)
			}
		case hasID:
			responses++
			_, hasResult := line["result"]
			_, hasError := line["error"]
			if !hasResult && !hasError {
				t.Errorf("response %v has neither a result nor an error", line)
			}
		default:
			t.Errorf("line %v is neither a response nor a notification", line)
		}
	}
	if responses != 2 {
		t.Errorf("got %d responses, want 2", responses)
	}
}

// TestServe_QuietEmitsNothingButResponses is the escape hatch for a client that asserts every
// line is a response instead of checking for an id.
func TestServe_QuietEmitsNothingButResponses(t *testing.T) {
	lines := serveOutputLines(t, serveOptions{Quiet: true}, `{"id":1,"method":"types"}`)
	if len(lines) != 1 {
		t.Fatalf("got %d output lines, want exactly the one response", len(lines))
	}
	if _, has := lines[0]["notification"]; has {
		t.Errorf("line = %v, want no notification under -quiet", lines[0])
	}
	if lines[0]["id"] != float64(1) {
		t.Errorf("line = %v, want the response to request 1", lines[0])
	}
}

// TestServe_ReadinessPrecedesTheFirstResponseEvenForAFastMethod pins the ordering rather than
// only the presence: a readiness line that arrived after the first answer would be saying
// "ready" too late to be worth saying.
func TestServe_ReadinessPrecedesTheFirstResponseEvenForAFastMethod(t *testing.T) {
	lines := serveOutputLines(t, serveOptions{}, `{"id":1,"method":"types"}`)
	for i, line := range lines {
		if _, has := line["id"]; has {
			if i == 0 {
				t.Errorf("the first line is a response; the readiness line must come before it")
			}
			return
		}
	}
	t.Error("no response line at all")
}

// TestProgressReporter_EmitsAHeartbeatWhileWorkRuns covers the shape a host consumes: the
// request it is about (under requestId, NOT id), the method, the phase, the file count and an
// elapsed time that is always present.
func TestProgressReporter_EmitsAHeartbeatWhileWorkRuns(t *testing.T) {
	var mu chanOfNotifications
	reporter, stop := startProgress(mu.add, 7, "loadPack")
	reporter.SetPhase("features")
	for i := 0; i < 12; i++ {
		reporter.AddFile()
	}
	// Long enough to pass progressDelay and take at least one tick.
	waitFor(t, func() bool { return mu.count() > 0 })
	stop()

	got := mu.first()
	if got.Kind != "progress" {
		t.Errorf("Kind = %q, want progress", got.Kind)
	}
	if got.RequestID != 7 {
		t.Errorf("RequestID = %v, want 7", got.RequestID)
	}
	if got.Method != "loadPack" {
		t.Errorf("Method = %q, want loadPack", got.Method)
	}
	if got.Phase != "features" {
		t.Errorf("Phase = %q, want features", got.Phase)
	}
	if got.Files != 12 {
		t.Errorf("Files = %d, want 12", got.Files)
	}
	if got.ElapsedMs <= 0 {
		t.Errorf("ElapsedMs = %d, want a positive elapsed time on every progress line", got.ElapsedMs)
	}
}

// TestProgressReporter_SaysNothingForFastWork is why progressDelay exists: a host showing a
// progress bar for a 700ms warm reload would be showing flicker.
func TestProgressReporter_SaysNothingForFastWork(t *testing.T) {
	var mu chanOfNotifications
	_, stop := startProgress(mu.add, 1, "loadPack")
	stop()
	if n := mu.count(); n != 0 {
		t.Errorf("%d progress lines for work that finished immediately, want none", n)
	}
}

// TestProgressReporter_StopWaitsForThePublisher pins the ordering guarantee a host depends on:
// no progress line for a request may arrive after that request's response, or a host that tears
// down per-request state on the response gets a line for a request it has forgotten.
func TestProgressReporter_StopWaitsForThePublisher(t *testing.T) {
	var mu chanOfNotifications
	reporter, stop := startProgress(mu.add, 1, "graph")
	reporter.SetPhase("graph")
	waitFor(t, func() bool { return mu.count() > 0 })
	stop()
	before := mu.count()
	time.Sleep(progressInterval + progressDelay)
	if after := mu.count(); after != before {
		t.Errorf("%d progress lines arrived after stop() returned, want none", after-before)
	}
}

// TestProgressReporter_NilIsANoOp is what lets handleLine (and -quiet) share one code path with
// the notifying one instead of branching at every call site.
func TestProgressReporter_NilIsANoOp(t *testing.T) {
	reporter, stop := startProgress(nil, 1, "loadPack")
	if reporter != nil {
		t.Errorf("startProgress with no notifier returned a reporter")
	}
	// Every method on a nil reporter must be safe -- this is the call shape the loadPack path
	// uses when nobody is listening.
	reporter.SetPhase("features")
	reporter.AddFile()
	stop()
}

// TestPackProgressHook_CountsEveryFileAndNamesTheKind is the join between pack.Load's per-file
// callback and the reporter, including the "only store the phase when it changes" rule that
// keeps the per-file cost to one atomic add.
func TestPackProgressHook_CountsEveryFileAndNamesTheKind(t *testing.T) {
	if hook := packProgressHook(nil); hook != nil {
		t.Fatal("packProgressHook(nil) must be nil, not a closure that does nothing per file")
	}
	reporter := &progressReporter{}
	hook := packProgressHook(reporter)
	for i := 0; i < 5; i++ {
		hook("features")
	}
	hook("biomes")
	if got := reporter.files.Load(); got != 6 {
		t.Errorf("files = %d, want 6", got)
	}
	if got := reporter.currentPhase(); got != "biomes" {
		t.Errorf("phase = %q, want biomes", got)
	}
}

// TestServe_LoadPackReportsProgressForASlowLoad drives the real method and asserts the file
// counts come from the pack rather than from a timer. Written against a pack small enough to
// load quickly, so the assertion is on the COUNTER (which the hook fills synchronously) rather
// than on a line arriving, which would make the test a race against progressDelay.
func TestServe_LoadPackReportsProgressCountsFromTheRealLoad(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 4; i++ {
		writeTestFile(t, filepath.Join(dir, "features", itoaHelper(i)+".json"),
			singleBlockFeatureJSON("test:f"+itoaHelper(i), "minecraft:stone"))
	}
	reporter := &progressReporter{}
	state := &serverState{}
	raw, err := json.Marshal(loadPackParams{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := methodLoadPack(state, raw, reporter); err != nil {
		t.Fatalf("methodLoadPack: %v", err)
	}
	// Four feature files plus whatever other kinds this pack has (it has none), so the count is
	// exactly the files that were read.
	if got := reporter.files.Load(); got != 4 {
		t.Errorf("files counted = %d, want 4", got)
	}
	// "building" is where the method ends: reading the files is only the first half, and a
	// progress line still saying "features" while the libraries build reads exactly like the
	// wedge these lines exist to rule out.
	if got := reporter.currentPhase(); got != "building" {
		t.Errorf("phase = %q, want building once the files are read", got)
	}
}

// chanOfNotifications is a tiny thread-safe recorder -- the notify func runs on the reporter's
// own goroutine, so a plain slice would be a data race the test would report before the
// behaviour did.
type chanOfNotifications struct {
	n    atomic.Int64
	seen atomic.Pointer[Notification]
}

func (c *chanOfNotifications) add(n Notification) {
	c.seen.CompareAndSwap(nil, &n)
	c.n.Add(1)
}

func (c *chanOfNotifications) count() int { return int(c.n.Load()) }

func (c *chanOfNotifications) first() Notification {
	if p := c.seen.Load(); p != nil {
		return *p
	}
	return Notification{}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out waiting for a progress notification")
}
