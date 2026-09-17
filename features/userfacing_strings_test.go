package features

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// toolingWords returns the tooling words that must never appear in user-facing
// text. They are stored reversed so this source file does not itself carry them.
func toolingWords() []string {
	return []string{
		reversed("ADI"), reversed("lbmessasid"), reversed("lbmessasiD"),
		reversed("lipmoced"), reversed("lipmoceD"), reversed("elbatv"),
		reversed("reenigne esrever"),
	}
}

// reversed returns s with its bytes in reverse order (ASCII input only).
func reversed(s string) string {
	b := []byte(s)
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	return string(b)
}

// TestUserFacingStringsStateBehaviourOnly is a repo-wide guard on ONE surface:
// the strings a pack author actually reads. An error from a build, a warning on
// a diagnostic, a placement failure -- these are the project's user interface,
// and each of them should state what the game does, in terms a pack author can
// act on, and nothing about internal tooling.
//
// `TestCoverageNotesAreUserFacing` guards the same class of text over
// CoverageEntry.Note; this test covers error and diagnostic strings.
//
// WHY IT IS SCOPED THIS NARROWLY: a blunt scan of every string literal in the
// repo would mostly report correct code (ordinary English uses of some of these
// words in test files, and the word lists themselves), and a guard with a high
// false-positive rate gets suppressed. So this one looks only where a string
// provably reaches a user.
func TestUserFacingStringsStateBehaviourOnly(t *testing.T) {
	root := repoRoot(t)

	// Kept in sync with TestCoverageNotesAreUserFacing's list on purpose: one
	// vocabulary, two surfaces.
	banned := toolingWords()
	// A hex or long decimal token. A user-facing sentence has no legitimate
	// reason to carry one.
	addr := regexp.MustCompile(`0x[0-9A-Fa-f]{4,}|\b[0-9]{7,}\b`)
	// A qualified C++-style name (Foo::bar, including the template form
	// Foo<T>::bar). A pack author cannot look such a name up, so a message
	// must describe the behaviour instead.
	//
	// Go's own package selectors (fmt.Errorf, block.AirID) use a dot, so this
	// cannot fire on them; the `::` is what makes it specific.
	qualifiedName := regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]+(?:<[^<>]*>)?::[~A-Za-z_][A-Za-z0-9_]*`)

	var checked int
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			switch info.Name() {
			case ".git", "node_modules", "dist", "out", "bin", "research", ".claude", ".scratch", "testdata":
				return filepath.SkipDir
			}
			return nil
		}
		// Test files are excluded: their strings are read by whoever is running
		// the tests, not by a pack author, and including them buys a stream of
		// false positives (a t.Errorf may legitimately use one of the banned words) for a
		// surface with no user on it.
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		fset := token.NewFileSet()
		file, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			// A file that does not parse is somebody else's failure, and failing
			// here too would only bury it.
			return nil
		}
		checked++
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || !isUserFacingCall(call) {
				return true
			}
			// Take every string literal in the call's subtree, so a message
			// assembled through fmt.Sprintf or concatenated across lines is
			// covered as well as a single literal.
			ast.Inspect(call, func(inner ast.Node) bool {
				lit, ok := inner.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					return true
				}
				text, uerr := strconv.Unquote(lit.Value)
				if uerr != nil {
					return true
				}
				pos := fset.Position(lit.Pos())
				rel, _ := filepath.Rel(root, pos.Filename)
				for _, w := range banned {
					if strings.Contains(text, w) {
						t.Errorf("%s:%d: a string a pack author reads contains %q.\n"+
							"  %s\n"+
							"  Say what the game DOES -- e.g. \"the game's own schema bound\".",
							rel, pos.Line, w, truncate(text))
					}
				}
				if m := addr.FindString(text); m != "" {
					t.Errorf("%s:%d: a string a pack author reads contains the hex/long-number token %q.\n"+
						"  %s\n"+
						"  The message should state the behaviour alone.",
						rel, pos.Line, m, truncate(text))
				}
				if m := qualifiedName.FindString(text); m != "" {
					t.Errorf("%s:%d: a string a pack author reads contains the qualified name %q.\n"+
						"  %s\n"+
						"  Describe the behaviour instead -- a pack author cannot look this name up.",
						rel, pos.Line, m, truncate(text))
				}
				return true
			})
			return false
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
	// A guard that silently inspected nothing looks exactly like a clean run.
	if checked < 50 {
		t.Fatalf("only %d files parsed under %s; this guard is not looking at the repo it thinks it is", checked, root)
	}
}

// isUserFacingCall reports whether call produces text a pack author reads:
// an error returned from a build or placement, a build diagnostic, or a
// placement failure. Everything else -- fmt.Sprintf into an internal value,
// a log line, a panic message -- is out of scope by design.
func isUserFacingCall(call *ast.CallExpr) bool {
	switch fn := call.Fun.(type) {
	case *ast.SelectorExpr:
		pkg, _ := fn.X.(*ast.Ident)
		switch fn.Sel.Name {
		case "Errorf":
			return pkg != nil && pkg.Name == "fmt"
		case "New":
			return pkg != nil && pkg.Name == "errors"
		case "Warn", "Warnf", "LogFailure":
			// A method on whatever holds the diagnostic sink -- ctx.Warn,
			// b.Warn, and so on. The receiver's name is not worth pinning.
			return true
		}
	case *ast.Ident:
		return fn.Name == "LogFailure"
	}
	return false
}

func truncate(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 140 {
		return s[:140] + "..."
	}
	return s
}

// repoRoot walks up from the test's own directory to the module root.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("no go.mod above %s", dir)
		}
		dir = parent
	}
}
