// blocknames.go — a whole-file sweep for block names that look right and are not.
//
// This is deliberately not part of any type's own parser. A name like `minecraft:cave_air` can
// appear in `places_block`, in `fill_with`, in a `may_replace` list, inside a `may_attach_to`
// map, or nested three levels down inside a structure constraint's allowlist -- every one of
// which is parsed by different code with a different shape. Checking them one field at a time
// would mean touching a dozen parsers and still missing the next field that accepts a block.
// One recursive pass over the file's already-decoded body catches all of them at once, and the
// cost of scanning a feature file is nothing next to building it.
package features

import (
	"fmt"

	"github.com/stirante/featurelab/block"
)

// notABedrockBlock lists names this engine does not have but that an author has a good reason to
// believe in: each one is either a Java Edition block or a name that appears in the engine
// somewhere that is NOT the block registry, which is exactly what makes it convincing.
//
// The value is what to say instead. Keep these narrow -- a false positive here tells someone to
// change working JSON, which is worse than saying nothing.
var notABedrockBlock = map[string]string{
	// In a recent game version this name exists only in the legacy structure palette mapping,
	// the table that translates block names stored in legacy structure files. It is not a
	// registered block, so a feature naming it resolves to
	// nothing and the feature places (or carves) nothing at all, silently.
	//
	// This one has been observed for real: it is what made a carver on a live client dig
	// nothing while every diagnostic stayed quiet, and it is a Java Edition habit -- there
	// cave_air is a distinct block, and it is what a Java worldgen tutorial tells you to write.
	"minecraft:cave_air": "minecraft:air",
}

// checkBlockNames walks a decoded feature body and reports every name in notABedrockBlock it
// finds, once per distinct name per file. It reports rather than fails: the name is inert in the
// real game rather than a load error, and this tool's job is to say so out loud.
func checkBlockNames(fileID, identifier string, body map[string]any, diags *[]Diagnostic) {
	seen := make(map[string]bool)
	var walk func(v any)
	walk = func(v any) {
		switch t := v.(type) {
		case string:
			if replacement, bad := notABedrockBlock[t]; bad && !seen[t] {
				seen[t] = true
				*diags = append(*diags, Diagnostic{Level: "warning", FileID: fileID, Message: fmt.Sprintf(
					"%s: %q is not a block on Bedrock -- it exists in the engine only inside the table "+
						"that translates names out of legacy structure files, never in the block registry. "+
						"The real game resolves it to nothing and this feature then places nothing, with no "+
						"error anywhere. Write %q instead.",
					identifier, t, replacement)})
			}
		case []any:
			for _, e := range t {
				walk(e)
			}
		case map[string]any:
			for _, e := range t {
				walk(e)
			}
		}
	}
	walk(body)
}

// warnUnknownBlockNames reports every block name one file's builder resolved
// that no block table this engine has contains -- the names
// block.Palette.TakeUnknownNames drained after that file's builder ran.
//
// A WARNING, never an error, and the distinction is the whole design. A block
// name is free text in the JSON: the file loads, the schema is satisfied, and
// the game will happily read it. What it cannot do is find the block, so the
// field silently does nothing -- a places_block that places nothing, a
// may_replace that matches nothing. That is a defect worth a row.
//
// But the engine's knowledge is not the world's. The two tables consulted (see
// block.Palette.KnowsBlockName) are the generated vanilla catalogue and THIS
// pack's own blocks/ directory. A block declared by a different add-on
// installed alongside this one is in neither, is perfectly real at run time,
// and its name is spelled exactly like a typo. Promoting this to an error
// would refuse working packs, so the message says where it looked and leaves
// the judgement with the author.
//
// Names covered by notABedrockBlock are skipped: checkBlockNames has already
// said something specific and more useful about them, and one problem reported
// twice reads as two problems.
func warnUnknownBlockNames(names []string, warn func(string)) {
	if warn == nil {
		return
	}
	for _, name := range names {
		if _, special := notABedrockBlock[name]; special {
			continue
		}
		warn(fmt.Sprintf("%q is not a block this engine knows: it is in none of the tables "+
			"consulted -- the generated vanilla block catalogue (`featurelab blocktable`), the "+
			"built-in legacy block-name table, and this pack's own blocks/ directory. If another "+
			"add-on installed alongside this one declares it, this is fine and there is nothing "+
			"to do; otherwise the game resolves the name to no block and whatever field named it "+
			"places or matches nothing -- check the namespace and the spelling.", name))
	}
}

// drainUnknownBlockNames is TakeUnknownNames with a nil-palette guard, so
// BuildLibrary can be called with no palette at all (several tests are) without
// a check for it at the call site.
func drainUnknownBlockNames(palette *block.Palette) []string {
	if palette == nil {
		return nil
	}
	return palette.TakeUnknownNames()
}
