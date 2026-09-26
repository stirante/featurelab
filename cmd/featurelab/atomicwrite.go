package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

// writeFileAtomic replaces path with data so that no reader ever sees a
// half-written file. os.WriteFile truncates the file and then fills it, and the
// pack's files are watched while that happens -- by the editor, by the
// extension's own file watcher and by the game's reload patch. A watcher that
// fires between the truncate and the write reads an empty file, and an empty
// feature is not a stale feature: it parses as nothing, and whatever reads it
// reports the file as broken. The same bytes written to a sibling and renamed
// over the target arrive all at once, or not at all.
//
// The temporary file lives in the target's own directory, because a rename
// is only atomic within one filesystem. Its name ends in a random suffix, not
// in .json, so a pack walk that runs meanwhile does not read it (the walk
// accepts files by suffix), and it starts with a dot so file explorers hide
// it. An existing file keeps its permission bits.
func writeFileAtomic(path string, data []byte, perm fs.FileMode) error {
	if info, err := os.Stat(path); err == nil {
		perm = info.Mode().Perm()
	}
	dir, base := filepath.Split(path)
	if dir == "" {
		dir = "."
	}
	tmp, err := os.CreateTemp(dir, "."+base+".featurelab-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// Every path out of here below either renames the temporary file into
	// place or removes it: a failed save must not leave litter in the pack.
	committed := false
	defer func() {
		if !committed {
			os.Remove(tmpName)
		}
	}()

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	// Flushed before the rename, so a crash cannot leave the new name pointing
	// at contents the disk never received.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		return err
	}
	if err := renameReplacing(tmpName, path); err != nil {
		if runtime.GOOS == "windows" && (errors.Is(err, fs.ErrPermission) || isSharingViolation(err)) {
			// Someone has held the target open without delete sharing for the
			// whole retry window. A rename cannot land until they let go, but an
			// in-place write can -- it is what os.WriteFile always did. A save
			// that fails outright is worse than one briefly visible half-done.
			return os.WriteFile(path, data, perm)
		}
		return err
	}
	committed = true
	return nil
}

// renameReplacing is os.Rename with patience for Windows. There, replacing a
// file fails with a sharing violation while another process holds it open
// without FILE_SHARE_DELETE -- a virus scanner, a search indexer, or the editor
// reading the file this very save just told it about. Those holds last
// milliseconds, so the rename is retried for about a second before the error
// is believed. Elsewhere a rename over an open file simply succeeds.
func renameReplacing(from, to string) error {
	err := os.Rename(from, to)
	if err == nil || runtime.GOOS != "windows" {
		return err
	}
	delay := 5 * time.Millisecond
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		if !errors.Is(err, fs.ErrPermission) && !isSharingViolation(err) {
			return err
		}
		time.Sleep(delay)
		if delay < 100*time.Millisecond {
			delay *= 2
		}
		if err = os.Rename(from, to); err == nil {
			return nil
		}
	}
	return err
}

// errorSharingViolation is Windows' ERROR_SHARING_VIOLATION. It is compared
// only on Windows (renameReplacing returns early elsewhere), so naming the
// number here avoids a platform-specific file for one constant.
const errorSharingViolation = syscall.Errno(32)

func isSharingViolation(err error) bool {
	var errno syscall.Errno
	return errors.As(err, &errno) && errno == errorSharingViolation
}
