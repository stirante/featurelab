package goldentest

import (
	"encoding/json"
	"fmt"
	"sort"
)

// ---------------------------------------------------------------------------
// Digest regeneration -- produces a DigestFile from THIS repo's own Go
// engine, consulting no external authority. See cmd/goldengen for the
// one-command entry point and the package doc comment for what the
// resulting baseline does and does not prove.
// ---------------------------------------------------------------------------

// digestMeta is the digest's "meta" block (pack/environment/hash/counts),
// kept in that shape so the file stays human-readable, plus a "source" field
// recording that it comes from the Go engine itself.
type digestMeta struct {
	Source      string `json:"source"`
	Pack        string `json:"pack"`
	Environment struct {
		EnvID  string `json:"envId"`
		Bounds struct {
			MinX  int `json:"minX"`
			MinY  int `json:"minY"`
			MinZ  int `json:"minZ"`
			SizeX int `json:"sizeX"`
			SizeY int `json:"sizeY"`
			SizeZ int `json:"sizeZ"`
		} `json:"bounds"`
		EnvSeed     int `json:"envSeed"`
		FeatureSeed int `json:"featureSeed"`
		Origin      Pos `json:"origin"`
		Biome       struct {
			ID   string   `json:"id"`
			Tags []string `json:"tags"`
		} `json:"biome"`
		DelegationBudget int `json:"delegationBudget"`
		WriteBudget      int `json:"writeBudget"`
	} `json:"environment"`
	Hash struct {
		Algorithm     string `json:"algorithm"`
		OffsetBasis   string `json:"offsetBasis"`
		Prime         string `json:"prime"`
		WriteEncoding string `json:"writeEncoding"`
		DrawEncoding  string `json:"drawEncoding"`
	} `json:"hash"`
	TotalFeatureFiles int `json:"totalFeatureFiles"`
	InScope           int `json:"inScope"`
	Pinnable          int `json:"pinnable"`
	NotPinnable       int `json:"notPinnable"`
}

// Regenerate places every in-scope feature (InScopeEntries) against h's
// pack/environment and returns a DigestFile built entirely from the
// results -- ordered write records and RNG draws, FNV-1a write/draw
// hashes, returned position, and final Molang scope, the exact shape and
// hashing CompareAgainst consumes. Chains that hit the write or
// delegation budget go into NotPinnable (mirroring the old digest's
// shape) rather than Features, since a budget-truncated run has no stable
// hash to pin. An in-scope chain that fails to build, or whose Place()
// panics with anything other than a budget, is a bug worth stopping on --
// Regenerate returns an error rather than silently omitting it, so a
// broken build can never produce a baseline that looks complete.
func Regenerate(h *Harness) (*DigestFile, error) {
	entries := InScopeEntries(h.Lib)

	var feats []DigestFeature
	var notPinnable []NotPinnable
	for _, e := range entries {
		if e.Feature == nil {
			return nil, fmt.Errorf("in-scope entry %s (%s, %s) failed to build", e.Identifier, e.TypeID, e.FileID)
		}

		out := PlaceOne(e.Feature, h.Proto, h.Baseline, h.Origin, h.Biome)
		if out.BudgetError != "" {
			notPinnable = append(notPinnable, NotPinnable{
				FileID:     e.FileID,
				Identifier: e.Identifier,
				TypeID:     e.TypeID,
				Reason:     out.BudgetError,
				Message:    fmt.Sprintf("%d writes / %d draws before the budget cut it off", len(out.Writes), len(out.Draws)),
			})
			continue
		}
		if out.OtherError != "" {
			return nil, fmt.Errorf("in-scope entry %s (%s, %s) panicked during placement: %s", e.Identifier, e.TypeID, e.FileID, out.OtherError)
		}

		writeHash := fnv1a64Hex(EncodeWrites(out.Writes))
		drawHash := fnv1a64Hex(EncodeDraws(out.Draws))

		var returned *Pos
		if out.Returned != nil {
			returned = &Pos{X: out.Returned.X, Y: out.Returned.Y, Z: out.Returned.Z}
		}
		scope := make([]rawScope, len(out.Scope))
		for i, s := range out.Scope {
			scope[i] = rawScope{NS: s.NS, Key: s.Key, Value: s.Value}
		}

		feats = append(feats, DigestFeature{
			FileID:     e.FileID,
			Identifier: e.Identifier,
			TypeID:     e.TypeID,
			WriteCount: len(out.Writes),
			WriteHash:  writeHash,
			DrawCount:  len(out.Draws),
			DrawHash:   drawHash,
			Returned:   returned,
			Scope:      scope,
			Detail:     false,
		})
	}

	sort.Slice(feats, func(i, j int) bool { return feats[i].Identifier < feats[j].Identifier })
	sort.Slice(notPinnable, func(i, j int) bool { return notPinnable[i].Identifier < notPinnable[j].Identifier })

	meta, err := buildDigestMeta(h, len(entries), len(feats), len(notPinnable))
	if err != nil {
		return nil, err
	}

	return &DigestFile{Meta: meta, NotPinnable: notPinnable, Features: feats}, nil
}

func buildDigestMeta(h *Harness, inScopeCount, pinnable, notPinnable int) (json.RawMessage, error) {
	var m digestMeta
	m.Source = "github.com/stirante/featurelab goldentest regeneration tool (goldentest/cmd/goldengen) -- Go engine output, no external authority consulted"
	// h.PackLabel, not PackDir: the same regeneration code produces the
	// digest for any pack, and the fixture digest is
	// committed, so it must record the repo-relative pack path rather than
	// whatever absolute path this machine resolved it to.
	m.Pack = h.PackLabel
	m.Environment.EnvID = "plains"
	m.Environment.Bounds.MinX, m.Environment.Bounds.MinY, m.Environment.Bounds.MinZ = h.Proto.MinX(), h.Proto.MinY(), h.Proto.MinZ()
	m.Environment.Bounds.SizeX, m.Environment.Bounds.SizeY, m.Environment.Bounds.SizeZ = h.Proto.SizeX(), h.Proto.SizeY(), h.Proto.SizeZ()
	m.Environment.EnvSeed = EnvSeed
	m.Environment.FeatureSeed = FeatureSeed
	m.Environment.Origin = Pos{X: h.Origin.X, Y: h.Origin.Y, Z: h.Origin.Z}
	m.Environment.Biome.ID = h.Biome.ID
	tags := make([]string, 0, len(h.Biome.Tags))
	for tg := range h.Biome.Tags {
		tags = append(tags, tg)
	}
	sort.Strings(tags)
	m.Environment.Biome.Tags = tags
	m.Environment.DelegationBudget = DelegationBudget
	m.Environment.WriteBudget = WriteBudget

	m.Hash.Algorithm = "FNV-1a-64"
	m.Hash.OffsetBasis = "0xcbf29ce484222325"
	m.Hash.Prime = "0x100000001b3"
	m.Hash.WriteEncoding = `per write: int32LE x, int32LE y, int32LE z, uint32LE nameByteLength, UTF-8 name bytes (name = "blockName" or "blockName#k=v,k2=v2" sorted by key)`
	m.Hash.DrawEncoding = "per draw, fixed 13 bytes: uint8 methodCode(0=NextInt,1=NextIntBound,2=NextFloat,3=NextDouble,4=NextBoolean,5=NextUnsignedInt), int32LE bound(0 if n/a), float64LE value(bool as 1.0/0.0)"

	m.TotalFeatureFiles = len(h.Lib.Entries)
	m.InScope = inScopeCount
	m.Pinnable = pinnable
	m.NotPinnable = notPinnable

	return json.Marshal(m)
}
