package main

// Diagnostic is the one normalized shape every pack-loading diagnostic gets
// converted to for CLI/serve JSON output -- mirrors session.Diagnostic's own
// {level, fileId, message} shape (session.go already does this same
// normalization for features/structures/rules diagnostics feeding into one
// session.Result.Diagnostics list; check needs the same normalization one
// level up, before a session even runs, since check's whole job is "did the
// pack load cleanly", not "did one generate succeed").
type Diagnostic struct {
	Level  string `json:"level"`
	FileID string `json:"fileId"`
	// Scope is session.ScopePack or session.ScopeRun -- see
	// session.Diagnostic.Scope for what the two mean and where the line is
	// drawn. Every diagnostic this type carries is pack-scoped in practice
	// (checkPack and loadPack both describe a pack, never a placement), but
	// it is on the wire rather than implied so a client has ONE rule for
	// reading a diagnostic, whichever method answered it.
	Scope string `json:"scope"`
	// Line and Column are the 1-based place in FileID, omitted when the
	// loader did not know one -- same contract as session.Diagnostic's pair.
	Line    int    `json:"line,omitempty"`
	Column  int    `json:"column,omitempty"`
	Message string `json:"message"`
}

// diagLevelHasError reports whether any diagnostic in diags is level
// "error" -- check's exit-code gate.
func diagLevelHasError(diags []Diagnostic) bool {
	for _, d := range diags {
		if d.Level == "error" {
			return true
		}
	}
	return false
}
