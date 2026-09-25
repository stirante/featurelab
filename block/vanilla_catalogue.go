package block

import (
	"hash/crc64"
	"sort"
)

// vanilla_catalogue.go lets the generated vanilla block catalogue skip being
// parsed.
//
// Every pack load stacks the 1238 vanilla block files under the pack's own
// blocks/ (see DefaultBlocks), and LoadBlockTags decoded every one of them as
// JSON to learn, in every case, the same thing: this file declares block X,
// with no tags, no placement filter, no traits and nothing about its looks. On
// a native build that is ~23ms of a pack load and easy to ignore. Compiled to
// WebAssembly for the browser playground it was ~230ms of a ~330ms first run,
// spent re-deriving an answer that was fixed when the catalogue was generated.
//
// So the answer is generated too (vanilla_catalogue_table.go, by
// cmd/genvanillacatalogue): one row per catalogue file, naming the block it
// declares. The generator refuses a file that declares anything more than
// that, so a row is never a summary that leaves something out -- a richer file
// would need a richer row, and the generator says so rather than writing one
// that silently drops it.
//
// A row is trusted only for the exact text it was generated from. It carries
// the file's length and checksum, and a file whose text does not match --
// a catalogue regenerated without regenerating this table, or a pack file
// that happens to share a vanilla file's id -- is parsed as if the table did
// not exist. A stale table therefore costs speed, never correctness; the
// staleness test in internal/genvanillacatalogue is what keeps it from costing
// even that.
//
//go:generate go run ../cmd/genvanillacatalogue -out vanilla_catalogue_table.go

// vanillaCatalogueRow is one catalogue file: its SourceFile id, the length
// and CatalogueChecksum of its text, and the identifier it declares.
type vanillaCatalogueRow struct {
	id         string
	size       int
	checksum   uint64
	identifier string
}

// cataloguedIdentifier returns the block identifier f declares when f is,
// byte for byte, a file the catalogue table was generated from -- in which
// case parsing it would find that identifier and nothing else.
func cataloguedIdentifier(f SourceFile) (string, bool) {
	i := sort.Search(len(vanillaCatalogue), func(i int) bool { return vanillaCatalogue[i].id >= f.ID })
	if i == len(vanillaCatalogue) {
		return "", false
	}
	row := &vanillaCatalogue[i]
	if row.id != f.ID || row.size != len(f.Text) || CatalogueChecksum(f.Text) != row.checksum {
		return "", false
	}
	return row.identifier, true
}

// CatalogueChecksum is the checksum a catalogue row keys a file's text by:
// CRC-64 (ECMA). Exported so the generator computes it with this function
// rather than with a copy of it.
//
// Not FNV, which the engine's other change detection uses: this runs over the
// whole catalogue, 800KB, on every pack load, and compiled to WebAssembly a
// byte-at-a-time FNV over that took several milliseconds where the standard
// library's table-driven CRC takes about one. It is 64 bits either way, and
// the id and length have to match as well.
func CatalogueChecksum(text string) uint64 {
	return crc64.Checksum([]byte(text), catalogueCRCTable)
}

var catalogueCRCTable = crc64.MakeTable(crc64.ECMA)
