package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestMCPMetadataCacheRefreshExpiryAndInvalidation(t *testing.T) {
	metadata, queries := 0, 0
	reject := false
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			metadata++
			w.Header().Set("x-ms-request-charge", "2")
			fmt.Fprint(w, `{"partitionKey":{"paths":["/tenant"]}}`)
			return
		}
		queries++
		if reject {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"code":"BadRequest","message":"partition mismatch"}`)
			return
		}
		w.Header().Set("x-ms-request-charge", "1")
		fmt.Fprint(w, `{"Documents":[{"id":"one"}]}`)
	}))
	defer s.Close()
	p := &plugin{}
	args := map[string]any{"connectionId": "one", "sql": "SELECT c.id FROM c", "partition_key_text": `["tenant"]`}
	life := mcpLifecycle(s.URL, "one")
	first, bad := invokeMCP(t, p, "query", args, life)
	if bad || first["metadata_source"] != "live" || first["ru"] != float64(3) {
		t.Fatal(first)
	}
	second, bad := invokeMCP(t, p, "query", args, life)
	if bad || second["metadata_source"] != "cache" || second["metadata_ru"] != float64(0) || second["ru"] != float64(1) || metadata != 1 {
		t.Fatal(second, metadata)
	}
	info, bad := invokeMCP(t, p, "container_info", map[string]any{"connectionId": "one", "refresh": true}, life)
	if bad || info["metadata_source"] != "live" || metadata != 2 {
		t.Fatal(info)
	}
	p.mcpMu.Lock()
	for key, v := range p.mcpMetadata {
		v.Fetched = time.Now().Add(-metadataTTL)
		p.mcpMetadata[key] = v
	}
	p.mcpMu.Unlock()
	_, bad = invokeMCP(t, p, "query", args, life)
	if bad || metadata != 3 {
		t.Fatal(metadata)
	}
	reject = true
	_, bad = invokeMCP(t, p, "query", args, life)
	if !bad || queries != 4 {
		t.Fatal("failed query automatically retried", queries)
	}
	reject = false
	last, bad := invokeMCP(t, p, "query", args, life)
	if bad || metadata != 4 || last["metadata_source"] != "live" {
		t.Fatal(last, metadata)
	}
	// Saved-connection identity is part of the cache key.
	args["connectionId"] = "two"
	_, bad = invokeMCP(t, p, "query", args, mcpLifecycle(s.URL, "two"))
	if bad || metadata != 5 {
		t.Fatal("cache crossed connections")
	}
}
