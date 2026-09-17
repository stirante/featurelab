// typeavailability.go — which feature TYPES a features/*.json file may name at all, given the
// `format_version` it declares.
//
// This is the coarsest of the game's version gates, and the only one that can make a whole
// file fail rather than a single key: the game keeps one JSON schema per format-version band,
// and a feature type exists in a band's schema only if the type's own minimum version falls
// inside that band or an earlier one. A file whose declared version lands in a band where the
// type is absent names a type that, as far as that schema is concerned, does not exist.
//
// Vanilla behaviour, in a recent game version:
//
//	there are five schema bands, one per feature schema version.
//	each band's schema has a REQUIRED "format_version" key carrying that band's version range.
//	the file's declared version is validated against the band's min and max, logging
//	    "Version %s below min required version (%s)" or
//	    "Version %s greater than max allowed version (%s)".
//	a type is available in every band that CONTAINS the type's min version and in every
//	    LATER band, never in an earlier one.
//	29 feature types are registered unconditionally; each has its own minimum band.
//
// The band table below carries the rest. The per-KEY gates are a different mechanism, applied
// per builder; see each builder's own header.
package features

// The five schema bands the game has, lowest first. A file whose declared format_version
// is below the first band's minimum matches NO band: its `format_version` key fails
// the version validation's min test in every band, so the file does not load at all. There is
// deliberately no band for feature schema version 0 (1.12.0) even though the version table has
// an entry for it.
//
// The bands are half-open [min, next.min) except the last, which is [1.26.50, any]. Only the
// minima matter here, because a type is available in its own band and every later one.
var featureSchemaBands = []FormatVersion{
	MustFormatVersion("1.13.0"),  // feature schema version 2
	MustFormatVersion("1.21.10"), // feature schema version 3
	MustFormatVersion("1.21.40"), // feature schema version 4
	MustFormatVersion("1.26.40"), // feature schema version 5
	MustFormatVersion("1.26.50"), // feature schema version 6
}

// FeatureSchemaFloor is the oldest format_version that matches any schema band at all.
var FeatureSchemaFloor = featureSchemaBands[0]

// typeMinFormatVersion holds the types whose registration is NOT at the floor. 27 of the 29
// types the game registers pass feature schema version 2 (= 1.13.0) and are therefore usable at every
// version a file can legally declare; listing them all here would be 27 rows that say nothing.
// The two exceptions were both introduced in 1.26.40 and are the reason this gate is
// observable at all:
//
//	minecraft:multi_block_feature             feature schema version 5-ish
//	minecraft:multipart_block_column_feature  feature schema version 5
//
// minecraft:horizontal_tree_decoration_feature — the third type new in game version 1.26.50 —
// is registered at feature schema version 2, so it is NOT gated: a file declaring "1.13.0" may
// may use it. That asymmetry is easy to guess wrong, so it is stated here rather than left to
// the absence of a row.
var typeMinFormatVersion = map[string]FormatVersion{
	"minecraft:multi_block_feature":            MustFormatVersion("1.26.40"),
	"minecraft:multipart_block_column_feature": MustFormatVersion("1.26.40"),
}

// MinFormatVersionForType returns the oldest format_version at which this build's schema
// registers typeID. For an unknown type id it returns the floor, which is the honest answer:
// this table says nothing about types the game does not register, and registry.go reports an
// unknown id on its own terms.
func MinFormatVersionForType(typeID string) FormatVersion {
	if v, ok := typeMinFormatVersion[typeID]; ok {
		return v
	}
	return FeatureSchemaFloor
}

// TypeAvailableAt reports whether a file declaring `declared` may name typeID.
//
// An ABSENT format_version returns true, which is exactly what the key-level gates do too —
// they all go through FormatVersion.AtLeastOrUnversioned, where the choice is argued once for
// the whole package. The reasoning is the same one registry.go applies when it downgrades a
// missing format_version from an error to a warning: the game would refuse such a file
// outright, the bench already says so once, and
// making the same omission ALSO delete the feature from the run would leave an author hunting
// for a second consequence of a problem they have already been told about. A file that declares
// a version is held to it exactly.
func TypeAvailableAt(typeID string, declared FormatVersion) bool {
	if !declared.Present {
		return true
	}
	return declared.Compare(MinFormatVersionForType(typeID)) >= 0
}
