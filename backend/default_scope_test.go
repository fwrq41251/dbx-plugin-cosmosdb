package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

func TestUIBrowseAndRequestsKeepSavedMCPDefault(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		switch {
		case r.URL.Path == "/dbs":
			fmt.Fprint(w, `{"Databases":[{"id":"Shop"},{"id":"Reports"}]}`)
		case r.URL.Path == "/dbs/Reports/colls":
			fmt.Fprint(w, `{"DocumentCollections":[{"id":"Events","partitionKey":{"paths":["/org"]}}]}`)
		case strings.HasSuffix(r.URL.Path, "/docs"):
			fmt.Fprint(w, `{"Documents":[{"id":"report","org":"one"}]}`)
		case strings.Contains(r.URL.Path, "/docs/"):
			fmt.Fprint(w, `{"id":"saved-document","tenant":"one"}`)
		default:
			fmt.Fprint(w, `{"id":"Orders","partitionKey":{"paths":["/tenant"]}}`)
		}
	}))
	defer server.Close()
	p := &plugin{connections: make(map[string]*cosmosClient)}
	lifecycle := mcpLifecycle(server.URL, "scope-test")
	raw, _ := json.Marshal(lifecycle)
	call := func(method, text string) any {
		t.Helper()
		result, err := p.Handle(sdk.RequestContext{}, method, json.RawMessage(text), nil)
		if err != nil {
			t.Fatal(method, err)
		}
		return result
	}
	call("connection/connect", string(raw))
	call("cosmos/databases", `{"connectionId":"scope-test","browse":true}`)
	call("cosmos/containers", `{"connectionId":"scope-test","database":"Reports","browse":true}`)
	result := call("cosmos/query", `{"connectionId":"scope-test","database":"Reports","container":"Events","query":"SELECT * FROM c","partitionKeyText":"[\"one\"]"}`).(page)
	if !strings.Contains(result.JSON, `"org":"one"`) {
		t.Fatal(result)
	}
	if paths[len(paths)-1] != "POST /dbs/Reports/colls/Events/docs" {
		t.Fatal(paths)
	}
	// The UI request never mutates the saved client defaults used by info/reopen.
	info := call("cosmos/info", `{"connectionId":"scope-test"}`).(map[string]any)
	if info["database"] != "Shop" || info["container"] != "Orders" {
		t.Fatal(info)
	}
	v, bad := invokeMCP(t, p, "read_document", map[string]any{"connectionId": "scope-test", "id": "saved-document", "partition_key_text": `["one"]`}, lifecycle)
	if bad || v["database"] != "Shop" || v["container"] != "Orders" {
		t.Fatal(v)
	}
	if paths[len(paths)-1] != "GET /dbs/Shop/colls/Orders/docs/saved-document" {
		t.Fatal(paths)
	}
	before := len(paths)
	_, bad = invokeMCP(t, p, "read_document", map[string]any{"connectionId": "scope-test", "id": "saved-document", "partition_key_text": `["one"]`, "database": "Reports", "container": "Events"}, lifecycle)
	if !bad || len(paths) != before {
		t.Fatal("MCP accepted UI scope override")
	}
	p.connections["scope-test"].readOnly = true
	before = len(paths)
	_, denied := p.Handle(sdk.RequestContext{}, "cosmos/create", json.RawMessage(`{"connectionId":"scope-test","database":"Reports","container":"Events","documentText":"{\"id\":\"new\",\"org\":\"one\"}","partitionKeyText":"[\"one\"]"}`), nil)
	if denied == nil || !strings.Contains(denied.Message, "read-only") || len(paths) != before {
		t.Fatal("readonly UI switch allowed a write", denied, paths)
	}
}
