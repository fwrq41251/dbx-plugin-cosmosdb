package main

import (
	"os"
	"runtime"
	"testing"
)

func assertPrivatePermissions(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		// Windows reports synthesized Unix mode bits; access is governed by the
		// containing user profile's ACL, not chmod(0600/0700). Persistence behavior
		// remains tested on Windows; this is only a Unix permission assertion.
		return
	}
	if info.Mode().Perm() != want {
		t.Fatalf("permissions for %s: %v, want %v", path, info.Mode().Perm(), want)
	}
}
