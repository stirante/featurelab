package wire

import (
	"context"

	"github.com/stirante/featurelab/pack"
	"github.com/stirante/featurelab/session"
)

// RunGenerate runs one feature/rule against an already-loaded pack by building a throwaway
// session.Workspace for this one call -- the one-shot `generate` subcommand / desktop-app path,
// which never runs a second placement in the same process (see session.Generate's own doc
// comment for why that's the right entry point here, and RunGenerateFromWorkspace below for the
// repeated-call path serve's "generate" method uses instead).
func RunGenerate(loaded *pack.Pack, params GenerateParams) (*GenerateOutput, error) {
	// This call HAS the pack, so it answers the one question a diagnostic's fileId needs and a
	// client cannot be trusted to (see GenerateParams.PackDir), rather than leaving a one-shot
	// `generate` as the last place in the tool that spells a file differently from the rest.
	params.PackDir = loaded.Dir
	cfg, err := BuildConfig(params)
	if err != nil {
		return nil, err
	}
	result, err := session.Generate(cfg, loaded.Features, loaded.Structures, loaded.Rules, loaded.Biomes, loaded.Blocks)
	if err != nil {
		return nil, err
	}
	return wrapGenerateOutput(cfg, result, params), nil
}

// RunGenerateFromWorkspace is RunGenerate's counterpart for a caller that holds a
// session.Workspace open across many calls -- serve's "generate" method (see serve.go's
// serverState.workspace), built once per "loadPack" and reused by every "generate" after it.
// Sharing BuildConfig/wrapGenerateOutput with RunGenerate above keeps the request/response
// contract identical between the one-shot and long-lived paths -- only which session.Generate
// entry point actually runs the placement differs.
func RunGenerateFromWorkspace(ws *session.Workspace, params GenerateParams) (*GenerateOutput, error) {
	return RunGenerateFromWorkspaceContext(context.Background(), ws, params)
}

// RunGenerateFromWorkspaceContext is RunGenerateFromWorkspace with a cancellation signal, for
// the long-lived server path: cancelling ctx abandons the placement and returns ctx.Err()
// instead of a GenerateOutput. See session.Workspace.GenerateContext for what the signal
// actually reaches and why a cancelled run answers with no partial result.
func RunGenerateFromWorkspaceContext(ctx context.Context, ws *session.Workspace, params GenerateParams) (*GenerateOutput, error) {
	cfg, err := BuildConfig(params)
	if err != nil {
		return nil, err
	}
	result, err := ws.GenerateContext(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return wrapGenerateOutput(cfg, result, params), nil
}

// wrapGenerateOutput promotes a session.Result into the GenerateOutput wire shape (bounds + the
// seeds actually used, see GenerateOutput's own doc comment) -- shared by RunGenerate and
// RunGenerateFromWorkspace so the two call paths can never drift apart on what a `generate`
// response contains.
func wrapGenerateOutput(cfg session.Config, result *session.Result, params GenerateParams) *GenerateOutput {
	if params.OmitPackDiagnostics {
		// Filtered in place on the Result, like OmitCatalogs below and for the same reason: the
		// Result is built fresh by this call and the field is serialised through the embedding,
		// so there is nothing else to shadow it on.
		//
		// A fresh slice rather than a filter into the same backing array: the Result is handed
		// to nothing else here, but an in-place compaction is the kind of thing that stays
		// correct exactly until someone adds a second reader.
		kept := make([]session.Diagnostic, 0, len(result.Diagnostics))
		for _, d := range result.Diagnostics {
			if d.Scope != session.ScopePack {
				kept = append(kept, d)
			}
		}
		// Never nil: `diagnostics` is not omitempty, and a client that walks the list must not
		// have to tell `null` from `[]` because it asked for fewer of them.
		result.Diagnostics = kept
	}
	if params.OmitCatalogs {
		// See GenerateParams.OmitCatalogs. Cleared on the Result rather than shadowed on the
		// wire type because GenerateOutput embeds *session.Result and these three fields are
		// serialised through that embedding; the Result is built fresh per call (session.
		// Generate constructs it), so clearing it affects nothing but this response.
		result.Entries = nil
		result.RuleEntries = nil
		result.BiomeEntries = nil
	}
	return &GenerateOutput{
		Bounds: Bounds{
			MinX: result.Volume.MinX(), MinY: result.Volume.MinY(), MinZ: result.Volume.MinZ(),
			SizeX: result.Volume.SizeX(), SizeY: result.Volume.SizeY(), SizeZ: result.Volume.SizeZ(),
		},
		FeatureSeed:     cfg.FeatureSeed,
		EnvironmentSeed: cfg.EnvironmentSeed,
		Result:          result,
	}
}
