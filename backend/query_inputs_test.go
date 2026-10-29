package main

import (
	"encoding/json"
	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestQueryInputsPreserveTextAndIsolateTargets(t *testing.T) {
	p := &plugin{}
	c := &cosmosClient{endpoint: "https://one.documents.azure.com", cacheID: "saved-one", cacheRoot: t.TempDir(), readOnly: true}
	input := queryInput{SQL: "  SELECT c.id\nFROM c WHERE ", PartitionKeyText: `["unfinished`, ParametersText: `[{"name":"@id","value":9223372036854775807}]`, PageSize: 250}
	if _, err := p.queryInputs(c, "Shop", "Orders", &input); err != nil {
		t.Fatal(err)
	}
	actual, err := p.queryInputs(c, "Shop", "Orders", nil)
	if err != nil || actual != input {
		t.Fatalf("%#v %v", actual, err)
	}
	for _, change := range []func(*cosmosClient){func(x *cosmosClient) { x.cacheID = "other" }, func(x *cosmosClient) { x.endpoint = "https://other.documents.azure.com" }} {
		other := &cosmosClient{endpoint: c.endpoint, cacheID: c.cacheID, cacheRoot: c.cacheRoot, readOnly: c.readOnly}
		change(other)
		value, err := p.queryInputs(other, "Shop", "Orders", nil)
		if err != nil || value != defaultQueryInput() {
			t.Fatal("connection isolation", value, err)
		}
	}
	for _, scope := range [][2]string{{"Other", "Orders"}, {"Shop", "Archive"}} {
		value, err := p.queryInputs(c, scope[0], scope[1], nil)
		if err != nil || value != defaultQueryInput() {
			t.Fatal("scope isolation", value, err)
		}
	}
	path, _ := c.scopedDataPath("query-input-v1", "Shop", "Orders")
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("file permission", info.Mode())
	}
	info, _ = os.Stat(filepath.Dir(path))
	if info.Mode().Perm() != 0700 {
		t.Fatal("directory permission", info.Mode())
	}
	// The UI may save on a read-only connection. This method is not a Cosmos write.
	p.connections = map[string]*cosmosClient{"saved-one": c}
	raw, _ := json.Marshal(map[string]any{"connectionId": "saved-one", "database": "Shop", "container": "Orders"})
	value, wire := p.Handle(sdk.RequestContext{}, "cosmos/queryInput", raw, nil)
	if wire != nil || value.(queryInput) != input {
		t.Fatal(value, wire)
	}
}
func TestQueryInputValidationAndReset(t *testing.T) {
	p := &plugin{}
	c := &cosmosClient{cacheRoot: t.TempDir(), cacheID: "one"}
	original := defaultQueryInput()
	original.SQL = "SELECT VALUE 1"
	_, _ = p.queryInputs(c, "db", "container", &original)
	for _, bad := range []queryInput{{SQL: strings.Repeat("x", 256*1024+1), PageSize: 100}, {PageSize: 10}, {SQL: strings.Repeat("\x00", 256*1024), ParametersText: strings.Repeat("\x00", 128*1024), PartitionKeyText: strings.Repeat("\x00", 16*1024), PageSize: 100}} {
		if _, err := p.queryInputs(c, "db", "container", &bad); err == nil {
			t.Fatal("invalid input persisted")
		}
		saved, err := p.queryInputs(c, "db", "container", nil)
		if err != nil || saved != original {
			t.Fatal("invalid save overwrote input", saved, err)
		}
	}
	path, _ := c.scopedDataPath("query-input-v1", "db", "container")
	for _, bad := range []string{`{"version":2,"input":{}}`, `null`, `{"version":1,"input":{"pageSize":100},"unknown":true}`, `{} {}`} {
		_ = os.WriteFile(path, []byte(bad), 0600)
		value, err := p.queryInputs(c, "db", "container", nil)
		if err == nil || value != defaultQueryInput() {
			t.Fatal("invalid record accepted", value, err)
		}
	}
	reset := defaultQueryInput()
	if _, err := p.queryInputs(c, "db", "container", &reset); err != nil {
		t.Fatal(err)
	}
	saved, err := p.queryInputs(c, "db", "container", nil)
	if err != nil || saved != reset {
		t.Fatal(saved, err)
	}
}
