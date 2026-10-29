package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	root, err := os.MkdirTemp("", "cosmos-scope-tests-")
	if err != nil {
		panic(err)
	}
	os.Setenv("DBX_PLUGIN_DATA_DIR", root)
	code := m.Run()
	os.RemoveAll(root)
	os.Exit(code)
}

func TestMCPReadsManagedPositionAndInvalidatesCursorsOnEveryScopeChange(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/docs") {
			w.Header().Set("x-ms-continuation", "next-page")
			fmt.Fprint(w, `{"Documents":[{"id":"one","tenant":"one"}]}`)
		} else {
			fmt.Fprint(w, `{"partitionKey":{"paths":["/tenant"]}}`)
		}
	}))
	defer server.Close()
	lifecycle := mcpLifecycle(server.URL, "managed")
	config := lifecycle["connection"].(map[string]any)["external_config"].(map[string]any)
	delete(config, "database_id")
	delete(config, "container_id")
	p := &plugin{}
	args := map[string]any{"connectionId": "managed", "sql": "SELECT * FROM c", "partition_key_text": `["one"]`, "page_size": 1}
	if _, bad := invokeMCP(t, p, "query", args, lifecycle); !bad {
		t.Fatal("unselected connection was queried")
	}
	c, err := newClient(server.URL, testKey, true)
	if err != nil {
		t.Fatal(err)
	}
	c.cacheID = "managed"
	if _, err = c.saveSelectedScope("Shop", "Orders", false); err != nil {
		t.Fatal(err)
	}
	first, bad := invokeMCP(t, p, "query", args, lifecycle)
	if bad || first["container"] != "Orders" || first["next_cursor"] == nil {
		t.Fatal(first)
	}
	args["cursor"] = first["next_cursor"]
	for _, target := range []string{"Archive", "Orders"} {
		if _, err = c.saveSelectedScope("Shop", target, false); err != nil {
			t.Fatal(err)
		}
		if result, bad := invokeMCP(t, p, "query", args, lifecycle); !bad {
			t.Fatal("old cursor survived a location change", result)
		}
	}
	delete(args, "cursor")
	result, bad := invokeMCP(t, p, "query", args, lifecycle)
	if bad || result["container"] != "Orders" {
		t.Fatal(result)
	}
}

func TestSelectedScopePersistenceIsolationAndMigration(t *testing.T) {
	c := &cosmosClient{endpoint: "https://account.example", cacheID: "one", cacheRoot: t.TempDir(), database: "Legacy", container: "Old"}
	initial, found, err := c.selectedScope()
	if err != nil || found || initial.Database != "Legacy" {
		t.Fatal(initial, found, err)
	}
	migrated, err := c.saveSelectedScope(initial.Database, initial.Container, true)
	if err != nil {
		t.Fatal(err)
	}
	selected, err := c.saveSelectedScope("Shop", "Orders", false)
	if err != nil || selected.Revision == migrated.Revision {
		t.Fatal(selected, err)
	}
	// A delayed legacy migration cannot replace a user's newer selection.
	actual, err := c.saveSelectedScope("Legacy", "Old", true)
	if err != nil || actual.Database != "Shop" {
		t.Fatal(actual, err)
	}
	reopened := &cosmosClient{endpoint: c.endpoint, cacheID: c.cacheID, cacheRoot: c.cacheRoot}
	actual, found, err = reopened.selectedScope()
	if err != nil || !found || actual != selected {
		t.Fatal(actual, found, err)
	}
	path, _ := c.selectedScopePath()
	assertPrivatePermissions(t, path, 0600)
	data, _ := os.ReadFile(path)
	var fields map[string]json.RawMessage
	json.Unmarshal(data, &fields)
	if len(fields) != 4 {
		t.Fatal("unexpected persisted data", string(data))
	}
	for _, other := range []*cosmosClient{
		{endpoint: c.endpoint, cacheID: "two", cacheRoot: c.cacheRoot},
		{endpoint: "https://different.example", cacheID: c.cacheID, cacheRoot: c.cacheRoot},
	} {
		if _, found, err := other.selectedScope(); err != nil || found {
			t.Fatal("scope leaked", found, err)
		}
	}
	if _, err := c.saveSelectedScope("Shop", "", false); err == nil {
		t.Fatal("partial position accepted")
	}
	if _, err := c.saveSelectedScope("/invalid", "Orders", false); err == nil {
		t.Fatal("invalid position accepted")
	}
	if current, _, _ := c.selectedScope(); current != selected {
		t.Fatal("failed update changed scope")
	}
}

func TestCorruptScopeCannotFallBackToLegacyTarget(t *testing.T) {
	c := &cosmosClient{endpoint: "https://account.example", cacheID: "one", cacheRoot: t.TempDir(), database: "Legacy", container: "Old"}
	path, _ := c.selectedScopePath()
	os.MkdirAll(filepath.Dir(path), 0700)
	os.WriteFile(path, []byte(`{"version":1,"database":"Other"}`), 0600)
	if _, _, err := c.selectedScope(); err == nil {
		t.Fatal("corrupt location silently selected a legacy target")
	}
	if _, err := c.saveSelectedScope("Recovered", "Container", false); err != nil {
		t.Fatal(err)
	}
	if location, found, err := c.selectedScope(); err != nil || !found || location.Database != "Recovered" {
		t.Fatal(location, found, err)
	}
}
