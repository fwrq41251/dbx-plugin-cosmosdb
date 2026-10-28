package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

func mcpLifecycle(host, id string) map[string]any {
	return map[string]any{"connection": map[string]any{
		"id": id, "host": host, "port": 443,
		"external_config":    map[string]any{"database_id": "Shop", "container_id": "Orders", "read_only": false},
		"connection_secrets": map[string]string{"account_key": "dGVzdC1hY2NvdW50LWtleQ=="},
	}}
}

func invokeMCP(t *testing.T, p *plugin, tool string, args map[string]any, lifecycle map[string]any) (map[string]any, bool) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"tool": tool, "arguments": args, "lifecycle": lifecycle})
	v, e := p.Handle(sdk.RequestContext{}, "mcp/call", raw, nil)
	if e != nil {
		t.Fatal(e)
	}
	r := v.(map[string]any)
	text := r["content"].([]any)[0].(map[string]any)["text"].(string)
	var result map[string]any
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatal(err)
	}
	return result, r["isError"].(bool)
}

func TestMCPDiscoveryBeforeConnect(t *testing.T) {
	p := &plugin{}
	v, e := p.Handle(sdk.RequestContext{}, "mcp/tools", json.RawMessage(`{}`), nil)
	if e != nil {
		t.Fatal(e)
	}
	tools := v.(map[string]any)["tools"].([]any)
	if len(tools) != 4 {
		t.Fatal(tools)
	}
	for _, entry := range tools {
		x := entry.(map[string]any)
		if x["annotations"].(map[string]any)["readOnlyHint"] != true {
			t.Fatal(x)
		}
		if x["inputSchema"].(map[string]any)["properties"].(map[string]any)["connectionId"] == nil {
			t.Fatal("missing host binding")
		}
	}
}

func TestMCPRejectsUnsafeCallsBeforeNetwork(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("invalid call reached network")
		w.WriteHeader(500)
	}))
	defer s.Close()
	base := map[string]any{"connectionId": "one", "sql": "SELECT * FROM c", "partition_key_text": `["tenant"]`}
	for _, tc := range []struct {
		name, tool string
		change     func(map[string]any)
		lifecycle  func(map[string]any)
	}{
		{"write", "cosmos/delete", nil, nil},
		{"create", "create", nil, nil},
		{"missing pk", "query", func(a map[string]any) { delete(a, "partition_key_text") }, nil},
		{"invalid pk", "query", func(a map[string]any) { a["partition_key_text"] = `[]` }, nil},
		{"scope override", "query", func(a map[string]any) { a["container"] = "Other" }, nil},
		{"endpoint injection", "query", func(a map[string]any) { a["host"] = "http://localhost:1" }, nil},
		{"credential injection", "query", func(a map[string]any) { a["account_key"] = "hidden" }, nil},
		{"binding mismatch", "query", func(a map[string]any) { a["connectionId"] = "two" }, nil},
		{"oversized page", "query", func(a map[string]any) { a["page_size"] = 101 }, nil},
		{"zero page", "query", func(a map[string]any) { a["page_size"] = 0 }, nil},
		{"null", "query", func(a map[string]any) { a["page_size"] = nil }, nil},
		{"invalid parameters", "query", func(a map[string]any) { a["parameters_text"] = `null` }, nil},
		{"unknown cursor", "query", func(a map[string]any) { a["cursor"] = "forged" }, nil},
		{"account scope", "query", nil, func(l map[string]any) { l["connection"].(map[string]any)["external_config"] = map[string]any{} }},
		{"proxy", "query", nil, func(l map[string]any) { l["runtime"] = map[string]any{"proxy": map[string]any{}} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := map[string]any{}
			for k, v := range base {
				a[k] = v
			}
			l := mcpLifecycle(s.URL, "one")
			if tc.change != nil {
				tc.change(a)
			}
			if tc.lifecycle != nil {
				tc.lifecycle(l)
			}
			v, failed := invokeMCP(t, &plugin{}, tc.tool, a, l)
			if !failed {
				t.Fatal(v)
			}
		})
	}
}

func TestMCPQueryPagingPrecisionAndBinding(t *testing.T) {
	var mu sync.Mutex
	requests := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			fmt.Fprint(w, `{"partitionKey":{"paths":["/_partition"]}}`)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		requests++
		if r.Method != "POST" || r.URL.Path != "/dbs/Shop/colls/Orders/docs" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("x-ms-documentdb-partitionkey") != `[9007199254740993]` || r.Header.Get("x-ms-max-item-count") != "20" {
			t.Error("precision/page size changed")
		}
		var q struct {
			Parameters []parameter `json:"parameters"`
		}
		_ = json.NewDecoder(r.Body).Decode(&q)
		if string(q.Parameters[0].Value) != "9007199254740993" {
			t.Error("parameter rounded")
		}
		w.Header().Set("x-ms-request-charge", "2.81")
		if r.Header.Get("x-ms-continuation") == "" {
			w.Header().Set("x-ms-continuation", "azure-cursor")
			fmt.Fprint(w, `{"Documents":[]}`)
		} else {
			fmt.Fprint(w, `{"Documents":[{"n":9007199254740993,"d":1.2300}]}`)
		}
	}))
	defer s.Close()
	p := &plugin{}
	l := mcpLifecycle(s.URL, "one")
	a := map[string]any{"connectionId": "one", "sql": "SELECT * FROM c", "partition_key_text": `[9007199254740993]`, "parameters_text": `[{"name":"@n","value":9007199254740993}]`}
	first, failed := invokeMCP(t, p, "query", a, l)
	if failed || first["count"] != float64(0) || first["has_more"] != true || first["ru"] != 2.81 {
		t.Fatal(first)
	}
	token := first["next_cursor"].(string)
	a["cursor"] = token
	for _, field := range []string{"sql", "partition_key_text", "parameters_text", "page_size", "connectionId"} {
		copy := map[string]any{}
		for k, v := range a {
			copy[k] = v
		}
		switch field {
		case "page_size":
			copy[field] = 10
		case "connectionId":
			copy[field] = "two"
		case "partition_key_text":
			copy[field] = `[1]`
		case "parameters_text":
			copy[field] = `[]`
		default:
			copy[field] = "SELECT c.id FROM c"
		}
		if v, bad := invokeMCP(t, p, "query", copy, l); !bad {
			t.Fatal("cursor crossed", field, v)
		}
	}
	second, failed := invokeMCP(t, p, "query", a, l)
	if failed || second["has_more"] != false || second["documents_json"] != `[{"n":9007199254740993,"d":1.2300}]` {
		t.Fatal(second)
	}
	p.mcpMu.Lock()
	c := p.mcpCursors[token]
	c.Expires = time.Now().Add(-time.Second)
	p.mcpCursors[token] = c
	p.mcpMu.Unlock()
	if v, bad := invokeMCP(t, p, "query", a, l); !bad {
		t.Fatal(v)
	}
	if requests != 2 {
		t.Fatal(requests)
	}
}

func TestMCPCacheNeverUsesNetwork(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cacheRoot := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cacheRoot)
	// os.UserCacheDir uses HOME/Library/Caches on macOS and XDG_CACHE_HOME on Linux.
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("cache caused network I/O") }))
	defer s.Close()
	c, _ := newClient(s.URL, "dGVzdC1hY2NvdW50LWtleQ==", true)
	c.cacheID = "one"
	path, _ := c.partitionCachePath("Shop", "Orders")
	defer os.RemoveAll(filepath.Dir(path))
	if err := c.writePartitionCache("Shop", "Orders", partitionCache{Keys: []string{`["Alpha"]`, `["Beta"]`, `[9007199254740993]`}, Complete: false}); err != nil {
		t.Fatal(err)
	}
	v, bad := invokeMCP(t, &plugin{}, "cached_partition_keys", map[string]any{"connectionId": "one", "filter": "ALPHA", "limit": 1}, mcpLifecycle(s.URL, "one"))
	if bad || v["found"] != true || v["complete"] != false || v["ru"] != float64(0) || v["matched_count"] != float64(1) {
		t.Fatal(v)
	}
	v, bad = invokeMCP(t, &plugin{}, "cached_partition_keys", map[string]any{"connectionId": "two"}, mcpLifecycle(s.URL, "two"))
	if bad || v["found"] != false {
		t.Fatal(v)
	}
}

func TestMCPFullHierarchicalPartitionAndMetadataCost(t *testing.T) {
	reads := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/dbs/Shop/colls/Orders" {
			w.Header().Set("x-ms-request-charge", "2")
			fmt.Fprint(w, `{"partitionKey":{"paths":["/tenant","/group"]}}`)
			return
		}
		reads++
		if r.Method != "GET" || r.Header.Get("x-ms-documentdb-partitionkey") != `["tenant",9007199254740993]` {
			t.Error("point read changed")
		}
		w.Header().Set("x-ms-request-charge", "1")
		fmt.Fprint(w, `{"id":"one","n":9007199254740993}`)
	}))
	defer s.Close()
	a := map[string]any{"connectionId": "one", "id": "one", "partition_key_text": `["tenant"]`}
	v, bad := invokeMCP(t, &plugin{}, "read_document", a, mcpLifecycle(s.URL, "one"))
	if !bad || reads != 0 || v["ru"] != float64(2) {
		t.Fatal(v, reads)
	}
	a["partition_key_text"] = `["tenant",9007199254740993]`
	v, bad = invokeMCP(t, &plugin{}, "read_document", a, mcpLifecycle(s.URL, "one"))
	if bad || reads != 1 || v["ru"] != float64(3) || v["metadata_ru"] != float64(2) || v["document_json"] != `{"id":"one","n":9007199254740993}` {
		t.Fatal(v)
	}
}

func TestMCPOversizedResultsAndServiceErrors(t *testing.T) {
	for _, tool := range []string{"query", "read_document"} {
		t.Run(tool, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/dbs/Shop/colls/Orders" {
					fmt.Fprint(w, `{"partitionKey":{"paths":["/_partition"]}}`)
					return
				}
				w.Header().Set("x-ms-request-charge", "7.5")
				w.Header().Set("x-ms-continuation", "next")
				doc := `{"id":"one","text":"` + strings.Repeat("x", mcpOutputLimit) + `"}`
				if tool == "query" {
					fmt.Fprint(w, `{"Documents":[`+doc+`]}`)
				} else {
					fmt.Fprint(w, doc)
				}
			}))
			defer s.Close()
			v, bad := invokeMCP(t, &plugin{}, tool, map[string]any{"connectionId": "one", "partition_key_text": `["tenant"]`, "id": "one", "sql": "SELECT * FROM c"}, mcpLifecycle(s.URL, "one"))
			// Use only the arguments belonging to this tool.
			if !bad {
				t.Fatal(v)
			}
			a := map[string]any{"connectionId": "one", "partition_key_text": `["tenant"]`}
			if tool == "query" {
				a["sql"] = "SELECT * FROM c"
			} else {
				a["id"] = "one"
			}
			v, bad = invokeMCP(t, &plugin{}, tool, a, mcpLifecycle(s.URL, "one"))
			if !bad || v["ru"] != 7.5 || v["next_cursor"] != nil {
				t.Fatal(v)
			}
		})
	}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-ms-activity-id", "activity")
		w.WriteHeader(429)
		fmt.Fprint(w, `{"message":"secret query literal"}`)
	}))
	defer s.Close()
	v, bad := invokeMCP(t, &plugin{}, "container_info", map[string]any{"connectionId": "one"}, mcpLifecycle(s.URL, "one"))
	encoded, _ := json.Marshal(v)
	if !bad || v["status"] != float64(429) || strings.Contains(string(encoded), "secret query literal") {
		t.Fatal(v)
	}
}
