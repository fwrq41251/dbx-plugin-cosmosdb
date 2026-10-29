package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestViewPreferencesPersistAndMergeAcrossConnections(t *testing.T) {
	root := t.TempDir()
	a, b := &cosmosClient{cacheRoot: root, cacheID: "a"}, &cosmosClient{cacheRoot: root, cacheID: "b"}
	p := &plugin{}
	v, err := p.viewPreferences(a, nil)
	if err != nil || v != defaultViewPreferences() {
		t.Fatalf("defaults: %v %v", v, err)
	}
	jsonView := "json"
	var wg sync.WaitGroup
	for _, patch := range []viewPreferencePatch{{Results: &jsonView}, {Document: &jsonView}} {
		wg.Add(1)
		go func(v viewPreferencePatch) {
			defer wg.Done()
			if _, err := p.viewPreferences(a, &v); err != nil {
				t.Error(err)
			}
		}(patch)
	}
	wg.Wait()
	v, err = (&plugin{}).viewPreferences(b, nil)
	if err != nil || v.Results != "json" || v.Document != "json" {
		t.Fatalf("restart/merge: %v %v", v, err)
	}
	path, _ := a.viewPreferencesPath()
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatalf("permissions: %v", info.Mode())
	}
	table := "table"
	v, err = p.viewPreferences(b, &viewPreferencePatch{Results: &table})
	if err != nil || v.Document != "json" || v.Results != "table" {
		t.Fatalf("independent views: %v %v", v, err)
	}
	before, _ := os.ReadFile(path)
	invalid := "secret-document-value"
	if _, err = p.viewPreferences(a, &viewPreferencePatch{Document: &invalid}); err == nil {
		t.Fatal("invalid view accepted")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("invalid preference overwrote saved values")
	}
}
func TestViewPreferencesCorruptionAndStorageFailure(t *testing.T) {
	c := &cosmosClient{cacheRoot: t.TempDir()}
	p := &plugin{}
	path, _ := c.viewPreferencesPath()
	for _, raw := range []string{`{`, `{"version":1,"results":"json","document":"other"}`, `{"version":1,"results":"json","document":"json","content":"private"}`, string(make([]byte, 4097))} {
		if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		v, err := p.viewPreferences(c, nil)
		if err != nil || v != defaultViewPreferences() {
			t.Fatalf("fallback: %v %v", v, err)
		}
	}
	jsonView := "json"
	if _, err := p.viewPreferences(c, &viewPreferencePatch{Document: &jsonView}); err != nil {
		t.Fatal(err)
	}
	v, err := p.viewPreferences(c, nil)
	if err != nil || v.Document != "json" {
		t.Fatal("repair failed")
	}
	blocked := filepath.Join(t.TempDir(), "file")
	os.WriteFile(blocked, []byte("x"), 0600)
	if _, err := p.viewPreferences(&cosmosClient{cacheRoot: blocked}, &viewPreferencePatch{Document: &jsonView}); err == nil {
		t.Fatal("storage failure hidden")
	}
}
