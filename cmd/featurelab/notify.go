// notify.go carries the lines `serve` writes to stdout that are NOT responses:
// one readiness line at start-up, and progress lines while a long method runs.
//
// # The line contract, which is what makes these safe to add
//
// `serve` speaks newline-delimited JSON. Every line it writes is one JSON
// object, and there are now exactly two kinds:
//
//   - A RESPONSE has an "id" member -- the id of the request it answers, echoed
//     verbatim, possibly null -- and exactly one of "result" or "error". This
//     is unchanged, byte for byte, from what it always was.
//
//   - A NOTIFICATION has a "notification" member naming its kind, and NEVER an
//     "id" member, a "result" or an "error".
//
// So the rule a client follows is: a line WITHOUT an "id" member is not an
// answer to anything -- ignore it unless you know the notification kind. A
// client that reads line-delimited JSON and correlates by id therefore cannot
// be broken by these, because it will never match one to an outstanding
// request and will never mistake one for a response to the request it is
// waiting on.
//
// That is also why a progress line names its request in "requestId" rather
// than "id", which would have been the obvious spelling and is exactly the one
// that breaks the naive client: it would correlate, resolve the caller's
// pending promise, and hand it a response with neither a result nor an error.
//
// A client that cannot tolerate extra lines at all -- one that asserts every
// line is a response rather than checking -- runs `serve -quiet`, which emits
// none of this and restores the previous behaviour exactly.
//
// # Why there is a readiness line at all
//
// `serve` used to print nothing until its first response. A host that spawned
// it had no way to tell "still starting" from "hung" except by sending a
// request and waiting for a timeout -- and the first request a host sends is
// usually "loadPack", the single slowest thing the engine does, so the timeout
// it waits out is the long one. One line at start-up turns that into a fact
// the host can act on immediately.
//
// # Why progress lines exist
//
// The engine is not always the reason a request is slow. A freshly written
// pack of 12.5k files was measured at 102s on FIRST touch against 2.3s warm --
// the difference is the OS and the machine's own on-access virus scanning
// reading every one of those files for the first time, which the engine can
// neither speed up nor opt out of. What it CAN do is keep saying what it is
// doing, so a host shows progress instead of a spinner, and so a host's own
// request timeout has something better to key off than elapsed time.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"sync/atomic"
	"time"
)

// Notification is one non-response line. Every field but Kind is omitempty:
// the two kinds share a struct because they share a contract (see this file's
// doc comment), not because either one uses all of it.
type Notification struct {
	// Kind is "ready" or "progress". A client must ignore a kind it does not
	// know rather than treat it as an error -- that is what makes adding a
	// third kind later a non-breaking change.
	Kind string `json:"notification"`

	// Ready is true on the readiness line, and is there rather than implied by
	// Kind because a host that only ever greps for one thing greps for this.
	Ready bool `json:"ready,omitempty"`
	// Version is versionInfo().Version -- the same string `version --json`
	// reports, so a host can check compatibility without a second process.
	Version string `json:"version,omitempty"`
	// PID is the engine process, for a host that supervises or kills it.
	PID int `json:"pid,omitempty"`

	// RequestID is the id of the request this progress line is about, spelled
	// exactly as that request spelled it. NOT "id" -- see the doc comment.
	RequestID any `json:"requestId,omitempty"`
	// Method is the method that is running.
	Method string `json:"method,omitempty"`
	// Phase is where inside that method the work currently is: an asset kind
	// while a pack is being read off disk ("features", "blocks"), or a named
	// stage of a longer method ("graph", "diagnostics").
	Phase string `json:"phase,omitempty"`
	// Files is how many files have been read so far, across every kind. It
	// only ever goes up within one request, and it is omitted (rather than
	// sent as 0) by a phase that does not count files -- a host must treat an
	// absent Files as "no count available", not as "zero read".
	Files int `json:"files,omitempty"`
	// ElapsedMs is how long this request has been running. Always present on a
	// progress line, and deliberately so: it is the field that makes one useful
	// even when nothing else about it changed, because it is what says the
	// engine is alive rather than wedged. (It is omitempty only so the
	// readiness line, which has no request to be elapsed against, does not
	// carry a meaningless zero -- a progress line is never emitted before
	// progressDelay, so its value is never zero.)
	ElapsedMs int64 `json:"elapsedMs,omitempty"`
}

// readyNotification is the start-up line, built here so serve.go and its tests
// cannot disagree about its shape.
func readyNotification() Notification {
	return Notification{Kind: "ready", Ready: true, Version: versionInfo().Version, PID: os.Getpid()}
}

func writeNotification(w *bufio.Writer, n Notification) error {
	b, err := json.Marshal(n)
	if err != nil {
		// Unreachable: every field is a string, an int or a JSON value that
		// already round-tripped through a request. Dropped rather than
		// reported, because a notification is by definition something nobody
		// is waiting for, and turning one into an error line would put a
		// line on stdout that IS correlated by a client.
		return nil
	}
	if _, err := w.Write(b); err != nil {
		return err
	}
	if err := w.WriteByte('\n'); err != nil {
		return err
	}
	return w.Flush()
}

// progressDelay is how long a request runs before it says anything. A method
// that finishes inside this emits nothing at all, which is the common case and
// the reason this is not simply "every second from zero": a warm loadPack is
// ~700ms on a large pack and a host showing a progress bar for it would be
// showing flicker.
const progressDelay = 750 * time.Millisecond

// progressInterval is the heartbeat after the first line. One second is chosen
// against what it is for: a person deciding whether a tool has hung, and a
// host deciding whether to keep waiting past its own timeout.
const progressInterval = 1 * time.Second

// progressReporter is the counter a running method updates and the goroutine
// that publishes it.
//
// The split matters for the requirement it is under: the work's side of this
// is one atomic add per file and one atomic store per phase, with NO
// formatting, NO marshalling, NO channel send and NO lock -- all of which
// happen on the reporter's own goroutine, once per second, regardless of how
// many files went past in that second. A pack read does not get slower in
// proportion to how long it takes to read.
//
// A nil *progressReporter is valid and every method on it is a no-op, so the
// paths that have nowhere to send notifications (the synchronous handleLine
// used by tests, `serve -quiet`) share one code path with the ones that do
// instead of branching at every call site.
type progressReporter struct {
	files atomic.Int64
	phase atomic.Pointer[string]
	stop  chan struct{}
	done  chan struct{}
}

// startProgress begins reporting for one request and returns the reporter plus
// the func that stops it. The stop func blocks until the publishing goroutine
// is gone, so no progress line can ever be written AFTER the response to the
// request it describes -- a host that tears down its per-request state on the
// response would otherwise get a line for a request it has already forgotten.
//
// notify may be nil (see progressReporter), in which case nothing is started
// and stopping is free.
func startProgress(notify func(Notification), id any, method string) (*progressReporter, func()) {
	if notify == nil {
		return nil, func() {}
	}
	r := &progressReporter{stop: make(chan struct{}), done: make(chan struct{})}
	started := time.Now()
	go func() {
		defer close(r.done)
		timer := time.NewTimer(progressDelay)
		defer timer.Stop()
		for {
			select {
			case <-r.stop:
				return
			case <-timer.C:
			}
			notify(Notification{
				Kind:      "progress",
				RequestID: id,
				Method:    method,
				Phase:     r.currentPhase(),
				Files:     int(r.files.Load()),
				ElapsedMs: time.Since(started).Milliseconds(),
			})
			timer.Reset(progressInterval)
		}
	}()
	return r, func() {
		close(r.stop)
		<-r.done
	}
}

// SetPhase names the stage the work has reached. Called once per stage, never
// per file.
func (r *progressReporter) SetPhase(phase string) {
	if r == nil {
		return
	}
	r.phase.Store(&phase)
}

// AddFile is the hot-path half: one atomic add, called once per file read.
func (r *progressReporter) AddFile() {
	if r == nil {
		return
	}
	r.files.Add(1)
}

func (r *progressReporter) currentPhase() string {
	if p := r.phase.Load(); p != nil {
		return *p
	}
	return ""
}
