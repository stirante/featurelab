package main

// serve_cancel_test.go covers the "cancel" method end to end, through a real runServe over
// pipes rather than through handleLine.
//
// It has to be the real loop: cancellation is a statement about two goroutines -- that one can
// read and answer a "cancel" while the other is mid-placement -- and handleLine, which runs a
// request to completion on the caller's own goroutine, cannot express that situation at all. A
// test that drove handleLine would pass against an engine where cancel does nothing.
//
// Every assertion here is something a user could see: how long they wait after pressing Cancel,
// that what they get back is not a half-drawn preview, and that the next thing they ask for
// still works.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// slowRulePack writes a pack whose one rule takes well over a second to place: a scatter
// distribution of a million iterations per chunk, each placing one block, across the four chunks
// a 32x32 bench covers.
//
// The slowness is in the ITERATION COUNT and nothing else -- no huge volume, no structure files,
// no textures -- so the response stays small and the cost is all in the placement loop, which is
// exactly the thing cancellation has to be able to interrupt. The budgets are raised out of the
// way because this pack is deliberately past every default one, and an aborted-by-budget run
// would prove nothing about cancelling.
func slowRulePack(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "features", "block.json"),
		singleBlockFeatureJSON("test:place_diamond", "minecraft:diamond_block"))
	writeTestFile(t, filepath.Join(root, "feature_rules", "rule.json"),
		`{"format_version":"1.21.110","minecraft:feature_rules":{`+
			`"description":{"identifier":"test:slow_rule","places_feature":"test:place_diamond"},`+
			`"conditions":{"placement_pass":"surface_pass"},`+
			`"distribution":{"iterations":1000000,`+
			`"x":{"distribution":"uniform","extent":[0,15]},"y":64,`+
			`"z":{"distribution":"uniform","extent":[0,15]}}}}`)
	return root
}

// slowGenerateParams is the request slowRulePack is built for.
func slowGenerateParams(t *testing.T) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"rule":                 "test:slow_rule",
		"size":                 "32x32x32",
		"omitCatalogs":         true,
		"placementTimeLimitMs": 600_000,
		"writeBudget":          200_000_000,
		"delegationBudget":     200_000_000,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// serveSession is one live runServe, driven the way a real client drives it: lines in on one
// pipe, response lines out on another, read as they arrive rather than after the loop ends.
type serveSession struct {
	t         *testing.T
	stdin     *io.PipeWriter
	responses chan Response
	// seen keeps every response that arrived out of order, by id, so a test can await them in
	// whatever order it finds convenient. Out-of-order is normal here rather than exceptional:
	// a "cancel" is answered while the request it cancels is still unwinding, so its own
	// acknowledgement routinely lands first.
	seen    map[float64]Response
	loop    sync.WaitGroup
	reader  sync.WaitGroup
	loopErr error
}

func newServeSession(t *testing.T) *serveSession {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	s := &serveSession{t: t, stdin: inW, responses: make(chan Response, 64), seen: map[float64]Response{}}

	s.loop.Add(1)
	go func() {
		defer s.loop.Done()
		s.loopErr = runServe(inR, outW)
		// Closing the write half is what ends the response reader below: without it a test that
		// waits for a response the server is never going to send would hang instead of failing.
		_ = outW.Close()
	}()

	s.reader.Add(1)
	go func() {
		defer s.reader.Done()
		defer close(s.responses)
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)
		for scanner.Scan() {
			// See runLines in serve_test.go: a line with no "id" member is a notification, not
			// a response, and a client correlating by id never sees one.
			if isNotificationLine(scanner.Bytes()) {
				continue
			}
			var r Response
			if err := json.Unmarshal(scanner.Bytes(), &r); err != nil {
				return
			}
			s.responses <- r
		}
	}()

	t.Cleanup(func() {
		_ = inW.Close()
		s.loop.Wait()
		s.reader.Wait()
		// A clean EOF on stdin is how a host shuts this engine down, and it has to be clean
		// however the session ended -- including one left holding a cancelled request.
		if s.loopErr != nil {
			t.Errorf("runServe returned %v, want a clean exit on EOF", s.loopErr)
		}
	})
	return s
}

func (s *serveSession) send(line string) {
	s.t.Helper()
	if _, err := io.WriteString(s.stdin, line+"\n"); err != nil {
		s.t.Fatalf("writing %s: %v", line, err)
	}
}

// await returns the response carrying id, keeping any that arrive before it for a later await --
// responses are correlated by id, and cancellation is the one part of this protocol that
// deliberately answers out of order.
func (s *serveSession) await(id float64, within time.Duration) Response {
	s.t.Helper()
	if r, ok := s.seen[id]; ok {
		delete(s.seen, id)
		return r
	}
	deadline := time.After(within)
	for {
		select {
		case r, ok := <-s.responses:
			if !ok {
				s.t.Fatalf("the engine closed its output before answering id %v", id)
			}
			got, isNum := r.ID.(float64)
			if !isNum {
				continue
			}
			if got == id {
				return r
			}
			s.seen[got] = r
		case <-deadline:
			s.t.Fatalf("no response to id %v within %v", id, within)
		}
	}
}

// loadSlowPack starts a session with slowRulePack loaded and ready to generate.
func loadSlowPack(t *testing.T) *serveSession {
	t.Helper()
	s := newServeSession(t)
	s.send(fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, slowRulePack(t)))
	if load := s.await(1, 30*time.Second); load.Error != nil {
		t.Fatalf("loadPack: %v", load.Error.Message)
	}
	return s
}

// TestServe_CancelStopsTheWorkNotJustTheWait is the assertion this whole feature exists for. It
// measures how long the SAME request takes uncancelled, then how long it takes when the user
// presses Cancel a moment in -- and requires the second to be a small fraction of the first.
//
// Fractional, not an absolute millisecond count, so it says the same thing on a slow machine as
// on a fast one. A cancel that only abandoned the wait would leave this at roughly 1.0: the
// engine would still be grinding through a million iterations per chunk and the response would
// still arrive when it finished.
func TestServe_CancelStopsTheWorkNotJustTheWait(t *testing.T) {
	params := slowGenerateParams(t)

	baselineSession := loadSlowPack(t)
	baselineStarted := time.Now()
	baselineSession.send(fmt.Sprintf(`{"id":2,"method":"generate","params":%s}`, params))
	if r := baselineSession.await(2, 5*time.Minute); r.Error != nil {
		t.Fatalf("the uncancelled baseline run failed: %v", r.Error.Message)
	}
	baseline := time.Since(baselineStarted)
	t.Logf("uncancelled baseline: %v", baseline)
	if baseline < 300*time.Millisecond {
		t.Fatalf("the baseline run took only %v -- too fast for this test to be able to tell a "+
			"cancelled run from a completed one; the fixture is no longer slow", baseline)
	}

	s := loadSlowPack(t)
	cancelStarted := time.Now()
	s.send(fmt.Sprintf(`{"id":2,"method":"generate","params":%s}`, params))
	// Long enough that the placement is genuinely under way, so this exercises stopping work in
	// progress rather than the (also correct, and covered below) case of cancelling something
	// still sitting in the queue. Short against a baseline measured in seconds.
	time.Sleep(150 * time.Millisecond)
	s.send(`{"id":3,"method":"cancel","params":{"id":2}}`)

	cancelled := s.await(2, 5*time.Minute)
	elapsed := time.Since(cancelStarted)
	t.Logf("cancelled run answered after %v (baseline %v)", elapsed, baseline)

	if cancelled.Error == nil {
		t.Fatalf("a cancelled generate answered with a result: %+v -- a run stopped part-way must "+
			"never be handed back as though it were what the user asked for", cancelled.Result)
	}
	if cancelled.Error.Code != errCancelledCode {
		t.Errorf("cancelled response code = %q, want %q -- a client has to be able to tell this "+
			"from a real failure without matching on the message", cancelled.Error.Code, errCancelledCode)
	}
	if cancelled.Result != nil {
		t.Errorf("cancelled response also carries a result: %+v", cancelled.Result)
	}

	if elapsed > baseline/2 {
		t.Errorf("the cancelled run answered after %v against an uncancelled baseline of %v -- "+
			"more than half, so the engine kept working after the cancel arrived", elapsed, baseline)
	}

	// The cancel's own response says the signal actually reached something.
	ack := s.await(3, 30*time.Second)
	if ack.Error != nil {
		t.Fatalf("cancel: %v", ack.Error.Message)
	}
	if got := ack.Result.(map[string]any)["cancelled"]; got != true {
		t.Errorf("cancel result = %v, want cancelled:true for a request that was still running", ack.Result)
	}

	// And the engine is still there afterwards. This is the half a "cancel" that killed the
	// process, or wedged the worker, would fail -- and the half a user notices immediately,
	// because the next thing they do after cancelling is ask for something else.
	s.send(`{"id":4,"method":"generate","params":{"feature":"test:place_diamond","size":"8x8x8","omitCatalogs":true}}`)
	next := s.await(4, 60*time.Second)
	if next.Error != nil {
		t.Fatalf("the request after a cancelled one failed: %v -- the engine did not stay healthy", next.Error.Message)
	}
	if next.Result == nil {
		t.Fatal("the request after a cancelled one returned no result")
	}
}

// TestServe_CancelForAnUnknownIDIsAHarmlessNoOp covers the case a client cannot avoid: it
// pressed Cancel just as the response was being written, so the cancel names an id that is
// already finished. That must not be an error, must not disturb anything else, and must not
// stop the engine answering the next request.
func TestServe_CancelForAnUnknownIDIsAHarmlessNoOp(t *testing.T) {
	s := newServeSession(t)

	s.send(`{"id":1,"method":"types"}`)
	if r := s.await(1, 30*time.Second); r.Error != nil {
		t.Fatalf("types: %v", r.Error.Message)
	}

	for _, line := range []string{
		`{"id":2,"method":"cancel","params":{"id":1}}`,      // finished
		`{"id":3,"method":"cancel","params":{"id":9999}}`,   // never existed
		`{"id":4,"method":"cancel","params":{"id":"nope"}}`, // never existed, and not even a number
		`{"id":5,"method":"cancel","params":{"id":9999}}`,   // twice
	} {
		s.send(line)
	}
	for id := float64(2); id <= 5; id++ {
		r := s.await(id, 30*time.Second)
		if r.Error != nil {
			t.Fatalf("cancel id %v answered with an error: %v -- cancelling something that is not "+
				"running is a normal thing for a client to do", id, r.Error.Message)
		}
		result, ok := r.Result.(map[string]any)
		if !ok {
			t.Fatalf("cancel id %v result is not an object: %+v", id, r.Result)
		}
		if result["cancelled"] != false {
			t.Errorf("cancel id %v = %v, want cancelled:false", id, result["cancelled"])
		}
	}

	s.send(`{"id":6,"method":"types"}`)
	if r := s.await(6, 30*time.Second); r.Error != nil {
		t.Fatalf("the request after four no-op cancels failed: %v", r.Error.Message)
	}
}

// TestServe_CancelWithNoIDIsRefusedRatherThanCancellingEverything pins the one cancel shape that
// must NOT be treated as a no-op: a params block with no id in it. Read as "cancel nothing" it
// would be silently useless; read as "cancel everything" it would be a client bug that stops a
// user's work. It is neither -- it is a malformed request, said so.
func TestServe_CancelWithNoIDIsRefusedRatherThanCancellingEverything(t *testing.T) {
	s := newServeSession(t)
	s.send(`{"id":1,"method":"cancel","params":{}}`)
	r := s.await(1, 30*time.Second)
	if r.Error == nil {
		t.Fatalf("cancel with no id answered with a result: %+v", r.Result)
	}
	if r.Error.Code == errCancelledCode {
		t.Errorf("a malformed cancel is reported as a cancellation: %+v", r.Error)
	}
}

// TestServe_CancelBeforeARequestStartsStopsItToo covers the other end of the race: the cancel
// arrives while the request is still queued behind something else, so the work never begins at
// all. The answer has to be the same cancellation either way -- a client cannot see which of the
// two happened, so the two must not be distinguishable.
func TestServe_CancelBeforeARequestStartsStopsItToo(t *testing.T) {
	s := loadSlowPack(t)
	params := slowGenerateParams(t)

	// Two slow runs, then a cancel for the SECOND one. The first is still running when the
	// cancel lands, so the second has certainly not started.
	s.send(fmt.Sprintf(`{"id":2,"method":"generate","params":%s}`, params))
	s.send(fmt.Sprintf(`{"id":3,"method":"generate","params":%s}`, params))
	time.Sleep(100 * time.Millisecond)
	s.send(`{"id":4,"method":"cancel","params":{"id":3}}`)
	// The first one too, so this test does not have to wait out a full run to finish.
	s.send(`{"id":5,"method":"cancel","params":{"id":2}}`)

	queued := s.await(3, 5*time.Minute)
	if queued.Error == nil || queued.Error.Code != errCancelledCode {
		t.Fatalf("the queued request answered %+v / %+v, want a cancellation", queued.Result, queued.Error)
	}
}

// TestServe_SessionGenerateContextReturnsNoPartialResult pins the contract underneath all of the
// above, one layer down from the protocol: the engine's own generate answers a cancelled context
// with an error and nothing else. A partial volume returned here would reach a panel as a
// perfectly well-formed preview of a feature that placed almost nothing.
func TestServe_SessionGenerateContextReturnsNoPartialResult(t *testing.T) {
	root := slowRulePack(t)
	state := &serverState{}
	handleLines(t, state, fmt.Sprintf(`{"id":1,"method":"loadPack","params":{"dir":%q}}`, root))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := methodGenerate(ctx, state, json.RawMessage(slowGenerateParams(t)))
	if err == nil {
		t.Fatalf("generate on a cancelled context returned a result: %+v", result)
	}
	if !isContextCancelled(err) {
		t.Errorf("generate returned %v, want the context's own cancellation", err)
	}
}

func isContextCancelled(err error) bool {
	return err == context.Canceled
}
