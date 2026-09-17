package main

// Diagnostic is the one normalized shape every pack-loading diagnostic gets
// converted to for CLI/serve JSON output -- mirrors session.Diagnostic's own
// {level, fileId, message} shape (session.go already does this same
// normalization for features/structures/rules diagnostics feeding into one
// session.Result.Diagnostics list; check needs the same normalization one
// level up, before a session even runs, since check's whole job is "did the
// pack load cleanly", not "did one generate succeed").
type Diagnostic struct {
	Level   string `json:"level"`
	FileID  string `json:"fileId"`
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
