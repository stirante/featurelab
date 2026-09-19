package wire

import (
	"context"
	"fmt"

	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/session"
)

// GrownGenerateOutput is the "grow to fit and regenerate" response shape -- see this package's
// doc comment, "Grow-and-regenerate", for the full two-call flow and why Grown/PreGrowBounds
// exist: without them, a caller has no wire-level way to tell this result apart from a normal
// GenerateOutput, and could render it as though it were just a wider view of the SAME run rather
// than what it actually is, a second and possibly DIFFERENT placement.
type GrownGenerateOutput struct {
	*GenerateOutput
	// Grown is true only when a second, larger run actually happened -- false means the first
	// (and only) run captured no overflowBlocks at all, so *GenerateOutput above is exactly that
	// unchanged first result. A caller must check this before labelling anything a "re-run".
	Grown bool `json:"grown"`
	// PreGrowBounds is the ORIGINAL (pre-grow) bench bounds that produced the overflow this grow
	// was based on -- present (non-nil) only when Grown is true, so a caller can report e.g.
	// "grew from 32x48x32 to 64x64x64" rather than just the new size in isolation.
	PreGrowBounds *Bounds `json:"preGrowBounds,omitempty"`
}

// RunGenerateGrown is RunGenerate's "grow to fit and regenerate" counterpart: the one-shot,
// no-reuse path (see RunGenerate's own doc comment for why that entry point exists) for a caller
// that wants the grow-and-regenerate action against an already-loaded pack.
func RunGenerateGrown(loaded *pack.Pack, params GenerateParams) (*GrownGenerateOutput, error) {
	return runGenerateGrown(params, func(p GenerateParams) (*GenerateOutput, error) {
		return RunGenerate(loaded, p)
	})
}

// RunGenerateGrownFromWorkspace is RunGenerateFromWorkspace's "grow to fit and regenerate"
// counterpart -- the repeated-call path serve's own methods use, reusing an already-built
// session.Workspace across both the initial and the grown call exactly like RunGenerateFromWorkspace
// itself does for a single call (see that function's own doc comment).
func RunGenerateGrownFromWorkspace(ws *session.Workspace, params GenerateParams) (*GrownGenerateOutput, error) {
	return RunGenerateGrownFromWorkspaceContext(context.Background(), ws, params)
}

// RunGenerateGrownFromWorkspaceContext is RunGenerateGrownFromWorkspace with a cancellation
// signal. Both of the two placements it may run are covered, and cancelling between them stops
// the second from starting -- which matters more here than anywhere else in this package,
// because a grow-and-regenerate is by construction the longest thing this engine does: a run
// that already overflowed, followed by a bigger one.
func RunGenerateGrownFromWorkspaceContext(ctx context.Context, ws *session.Workspace, params GenerateParams) (*GrownGenerateOutput, error) {
	return runGenerateGrown(params, func(p GenerateParams) (*GenerateOutput, error) {
		return RunGenerateFromWorkspaceContext(ctx, ws, p)
	})
}

// runGenerateGrown is the shared implementation behind RunGenerateGrown/RunGenerateGrownFromWorkspace
// -- both differ only in which underlying `generate` entry point actually runs a placement (a
// throwaway Workspace vs. a caller-held one), so that single difference is the only thing the
// `gen` callback captures; the two-call "run, check overflow, maybe run again bigger" flow itself
// lives here exactly once.
func runGenerateGrown(params GenerateParams, gen func(GenerateParams) (*GenerateOutput, error)) (*GrownGenerateOutput, error) {
	initial, err := gen(params)
	if err != nil {
		return nil, err
	}
	if len(initial.OverflowBlocks) == 0 {
		// Nothing spilled -- there is nothing to grow for, and running a second, identical
		// placement would waste the caller's time for no benefit. *GenerateOutput here IS the
		// complete, correct answer; Grown: false is what tells a caller not to look for a
		// "grew from X to Y" story that never happened.
		return &GrownGenerateOutput{GenerateOutput: initial, Grown: false}, nil
	}

	origBounds := initial.Bounds
	sizeX, sizeY, sizeZ, minY := session.GrowBounds(
		origBounds.MinX, origBounds.SizeX,
		origBounds.MinY, origBounds.SizeY,
		origBounds.MinZ, origBounds.SizeZ,
		initial.Origin.X, initial.Origin.Z,
		initial.OverflowBlocks,
	)

	grownParams := params
	grownParams.Size = fmt.Sprintf("%dx%dx%d", sizeX, sizeY, sizeZ)
	my := minY
	grownParams.MinY = &my

	grown, err := gen(grownParams)
	if err != nil {
		return nil, fmt.Errorf("grow-and-regenerate: %w", err)
	}
	pb := origBounds
	return &GrownGenerateOutput{GenerateOutput: grown, Grown: true, PreGrowBounds: &pb}, nil
}
