package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestWriteValidatesPartitionBeforeMutation(t *testing.T) {
	writes := 0
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			writes++
			t.Error("invalid partition reached mutation")
		}
		fmt.Fprint(w, `{"partitionKey":{"paths":["/tenant"]}}`)
	}, false)
	r := testRequest()
	r.Document = json.RawMessage(`{"id":"one","tenant":"different"}`)
	for _, method := range []string{"cosmos/create", "cosmos/replace"} {
		if _, err := c.documents(method, r); err == nil || !strings.Contains(err.Error(), "分区键") {
			t.Fatalf("%s: %v", method, err)
		}
	}
	if writes != 0 {
		t.Fatal(writes)
	}
	meta := json.RawMessage(`{"partitionKey":{"paths":["/n"]}}`)
	if err := validateDocumentPartition(json.RawMessage(`{"n":9223372036854775807}`), json.RawMessage(`[9223372036854775807]`), meta); err != nil {
		t.Fatal(err)
	}
	if err := validateDocumentPartition(json.RawMessage(`{"n":9223372036854775808}`), json.RawMessage(`[9223372036854775807]`), meta); err == nil {
		t.Fatal("partition number rounded")
	}
}

func TestMutationCacheKeepsKeysUntilTheirLastDocumentIsDeleted(t *testing.T) {
	remaining := true
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-ms-documentdb-partitionkey") != `["new"]` || r.Header.Get("x-ms-max-item-count") != "1" {
			t.Error("cache check was not partition scoped")
		}
		w.Header().Set("x-ms-request-charge", "2")
		if remaining {
			fmt.Fprint(w, `{"Documents":[{"id":"other"}]}`)
		} else {
			fmt.Fprint(w, `{"Documents":[]}`)
		}
	}, false)
	c.cacheRoot = t.TempDir()
	r := testRequest()
	r.PartitionKey = json.RawMessage(`["new"]`)
	if _, err := c.observeMutation(r, false); err != nil {
		t.Fatal(err)
	}
	cache, err := c.readPartitionCache(r.Database, r.Container)
	if err != nil || cache.Complete || len(cache.Keys) != 1 {
		t.Fatalf("%+v %v", cache, err)
	}
	if _, err = c.observeMutation(r, true); err != nil {
		t.Fatal(err)
	}
	cache, _ = c.readPartitionCache(r.Database, r.Container)
	if len(cache.Keys) != 1 {
		t.Fatal("removed an occupied partition")
	}
	remaining = false
	if ru, err := c.observeMutation(r, true); err != nil || ru != 2 {
		t.Fatalf("%v %v", ru, err)
	}
	cache, _ = c.readPartitionCache(r.Database, r.Container)
	if len(cache.Keys) != 0 {
		t.Fatal("last document partition left cached")
	}
}
