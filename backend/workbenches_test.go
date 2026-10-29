package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
)

func TestWorkbenchInputsScopesAndRestartIsolation(t *testing.T) {
	p := &plugin{}
	c := &cosmosClient{endpoint: "https://dev.documents.azure.com", cacheID: "dev", cacheRoot: t.TempDir()}
	if _, err := c.saveSelectedScope("Shop", "Orders", false); err != nil {
		t.Fatal(err)
	}
	legacy := defaultQueryInput()
	legacy.SQL = "SELECT legacy"
	if _, err := p.queryInputs(c, "Shop", "Orders", &legacy); err != nil {
		t.Fatal(err)
	}
	a, err := p.openWorkbench(c, "a", "", false)
	if err != nil || a.Container != "Orders" {
		t.Fatal(a, err)
	}
	first, err := p.queryInputs(c, "Shop", "Orders", nil, "a")
	if err != nil || first != legacy {
		t.Fatal("legacy migration", first, err)
	}
	b, err := p.openWorkbench(c, "b", "a", true)
	if err != nil || b.Container != "Orders" {
		t.Fatal(b, err)
	}
	blank, err := p.queryInputs(c, "Shop", "Orders", nil, "b")
	if err != nil || blank != defaultQueryInput() {
		t.Fatal("New Query copied source input", blank, err)
	}
	// Concurrent tabs on the same connection/container must own different files.
	var wg sync.WaitGroup
	for _, id := range []string{"a", "b"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			v := defaultQueryInput()
			v.SQL = "SELECT " + id
			v.PartitionKeyText = `["` + id + `"]`
			for i := 0; i < 10; i++ {
				if _, err := p.queryInputs(c, "Shop", "Orders", &v, id); err != nil {
					t.Error(err)
				}
			}
		}(id)
	}
	wg.Wait()
	if _, err := c.saveSelectedScope("Shop", "Archive", false); err != nil {
		t.Fatal(err)
	}
	if err := p.saveWorkbenchScope(c, "b", selectedScope{Database: "Shop", Container: "Archive"}); err != nil {
		t.Fatal(err)
	}
	// A new workspace inherits the source's position, even when the connection
	// default has since been changed by another workspace.
	child, err := p.openWorkbench(c, "c", "a", true)
	if err != nil || child.Container != "Orders" {
		t.Fatal("wrong source location", child, err)
	}
	restarted := &plugin{}
	for id, container := range map[string]string{"a": "Orders", "b": "Archive", "c": "Orders"} {
		restored, err := restarted.openWorkbench(c, id, "b", true)
		if err != nil || restored.Container != container {
			t.Fatal(id, restored, err)
		}
	}
	for _, id := range []string{"a", "b"} {
		restored, err := restarted.queryInputs(c, "Shop", "Orders", nil, id)
		if err != nil || restored.SQL != "SELECT "+id {
			t.Fatal(id, restored, err)
		}
	}
	fallback, err := p.queryInputs(c, "Shop", "Orders", nil)
	if err != nil || fallback.SQL != "SELECT a" {
		t.Fatal("New Query overwrote main-tab fallback", fallback, err)
	}
	// Restoring old tabs must not change the default or invalidate MCP cursors.
	shared, _, _ := c.selectedScope()
	if shared.Container != "Archive" {
		t.Fatal(shared)
	}
	other := &cosmosClient{endpoint: c.endpoint, cacheID: "other", cacheRoot: c.cacheRoot}
	if _, found, _ := other.readWorkbench("a"); found {
		t.Fatal("cross-connection workbench leak")
	}
	other.endpoint = "https://other.documents.azure.com"
	other.cacheID = c.cacheID
	if _, found, _ := other.readWorkbench("a"); found {
		t.Fatal("cross-endpoint workbench leak")
	}
}
func TestWorkbenchValidationAndUnavailableStorage(t *testing.T) {
	p := &plugin{}
	c := &cosmosClient{cacheID: "dev", cacheRoot: t.TempDir()}
	for _, id := range []string{"../other", strings.Repeat("x", 129), "a\x00b"} {
		if _, err := p.openWorkbench(c, id, "", false); err == nil {
			t.Fatal("invalid id accepted", id)
		}
	}
	if _, err := p.queryInputs(c, "Shop", "Orders", nil, "unknown"); err == nil {
		t.Fatal("unopened workspace accepted")
	}
	if _, err := p.openWorkbench(c, "a", "", false); err != nil {
		t.Fatal(err)
	}
	path, _ := c.scopedDataPath("workbenches-v1", "", "", "a")
	for _, bad := range []string{`{"version":2}`, `{"version":1,"database":"Shop"}`, `{"version":1,"unknown":true}`, `null`} {
		if err := os.WriteFile(path, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := p.openWorkbench(c, "a", "", false); err == nil {
			t.Fatal("corrupt record accepted", bad)
		}
	}
}
func TestParallelWorkbenchCancellationDoesNotDisconnectSibling(t *testing.T) {
	p := &plugin{}
	a, finishA, err := p.beginQuery("dev", "query-a")
	if err != nil {
		t.Fatal(err)
	}
	defer finishA()
	b, finishB, err := p.beginQuery("dev", "query-b")
	if err != nil {
		t.Fatal(err)
	}
	defer finishB()
	if _, wire := p.cancelQuery("dev", "query-a"); wire != nil {
		t.Fatal(wire)
	}
	if a.Err() != context.Canceled || b.Err() != nil {
		t.Fatal("sibling canceled", a.Err(), b.Err())
	}
	// Workbench state has no credentials/results/documents and never exposes MCP.
	raw, _ := json.Marshal(workbenchRecord{Version: 1, Database: "Shop", Container: "Orders", NewQuery: true})
	if strings.Contains(string(raw), "sql") || strings.Contains(string(raw), "key") {
		t.Fatal(string(raw))
	}
}
