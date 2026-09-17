// identifier.go -- extracts a feature/rule's identifier from its JSON text, for the pack
// item picker this app needs since (unlike the VS Code extension) there is no open editor
// document to read an identifier out of. Mirrors apps/vscode/src/identifier.ts's
// parseFeatureIdentifier exactly (same "one top-level key besides format_version is the type
// id, body.description.identifier is the identifier" convention that file's own doc comment
// attributes to features/registry.go's parseFile) so a pack item this app lists is exactly
// one `featurelab generate --feature <id>` / `--rule <id>` could also place.
package main

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/stirante/featurelab/jsonc"
	"github.com/stirante/featurelab/pack"
)

// PackItemKind distinguishes a feature from a feature rule in the picker -- wire.GenerateParams
// needs to know which of its Feature/Rule fields to fill in.
type PackItemKind string

const (
	PackItemFeature PackItemKind = "feature"
	PackItemRule    PackItemKind = "rule"
)

// PackItem is one pickable entry: a feature or feature_rules file this app found under the
// loaded pack, identified the same way the engine itself identifies it (description.identifier,
// not the file path -- a file's path and its identifier are independent in Bedrock).
type PackItem struct {
	Kind       PackItemKind `json:"kind"`
	Identifier string       `json:"identifier"`
	TypeID     string       `json:"typeId"`
	FileID     string       `json:"fileId"`
}

// identifierFromJSON extracts (identifier, typeId) from one feature/feature_rules JSON
// file's text -- mirrors identifier.ts's parseFeatureIdentifier's parsing rule exactly,
// generalized to also return the type key (the one top-level key besides "format_version")
// since PackItem surfaces it for display.
func identifierFromJSON(text string) (identifier, typeID string, err error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(jsonc.StripComments([]byte(text)), &root); err != nil {
		return "", "", fmt.Errorf("not valid JSON: %w", err)
	}
	for key, body := range root {
		if key == "format_version" {
			continue
		}
		typeID = key
		var withDescription struct {
			Description struct {
				Identifier string `json:"identifier"`
			} `json:"description"`
		}
		if err := json.Unmarshal(body, &withDescription); err != nil {
			return "", "", fmt.Errorf("%q must be an object: %w", key, err)
		}
		if withDescription.Description.Identifier == "" {
			return "", "", fmt.Errorf("%q.description.identifier is missing", key)
		}
		return withDescription.Description.Identifier, typeID, nil
	}
	return "", "", fmt.Errorf("no feature type key alongside \"format_version\" -- is this a feature/feature_rules JSON file?")
}

// listPackItems walks every loaded features/*.json and feature_rules/*.json file and returns
// the ones that parse as a recognizable single-feature/single-rule JSON body, sorted by
// identifier -- best-effort, like pack.Load's own warnings convention: a file that fails to
// parse here is simply omitted from the picker (it will still surface as a real error, with
// a useful message, the moment a caller tries to generate/check it), not a reason to fail
// listing every other file in the pack.
func listPackItems(p *pack.Pack) []PackItem {
	items := make([]PackItem, 0, len(p.Features)+len(p.Rules))
	for _, f := range p.Features {
		id, typeID, err := identifierFromJSON(f.Text)
		if err != nil {
			continue
		}
		items = append(items, PackItem{Kind: PackItemFeature, Identifier: id, TypeID: typeID, FileID: f.ID})
	}
	for _, r := range p.Rules {
		id, typeID, err := identifierFromJSON(r.Text)
		if err != nil {
			continue
		}
		items = append(items, PackItem{Kind: PackItemRule, Identifier: id, TypeID: typeID, FileID: r.ID})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Kind != items[j].Kind {
			return items[i].Kind < items[j].Kind
		}
		return items[i].Identifier < items[j].Identifier
	})
	return items
}
