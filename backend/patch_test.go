package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestPatchSendsOnlyChangedPathsWithAtomicVersionGuard(t *testing.T) {
	writes := 0
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-ms-request-charge", "2")
		if r.Method == "GET" {
			fmt.Fprint(w, `{"partitionKey":{"paths":["/tenant"]}}`)
			return
		}
		writes++
		if r.Method != "PATCH" || r.Header.Get("Content-Type") != "application/json_patch+json" || r.Header.Get("If-Match") != `"version-1"` || r.Header.Get("x-ms-documentdb-partitionkey") != `["tenant"]` {
			t.Fatal("unsafe patch request")
		}
		var body struct {
			Operations []patchOperation `json:"operations"`
			Condition  string           `json:"condition"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Operations) != 2 || string(body.Operations[0].Value) != "9223372036854775807" || body.Condition != `from c where c._etag = "\"version-1\""` {
			t.Fatalf("%+v", body)
		}
		fmt.Fprint(w, `{"id":"one","tenant":"tenant","count":9223372036854775807}`)
	}, false)
	r := testRequest()
	r.Operations = []patchOperation{{Op: "set", Path: "/count", Value: json.RawMessage(`9223372036854775807`)}, {Op: "remove", Path: "/old"}}
	p, err := c.patchDocument(r)
	if err != nil || writes != 1 || p.RU != 4 {
		t.Fatalf("%+v %v writes=%d", p, err, writes)
	}
}

func TestPatchValidationProtectsIdentityAndPartitionAncestors(t *testing.T) {
	for _, path := range []string{"/id", "/id/x", "/_etag", "/_ts/x", "/account", "/account/tenant", "/account/tenant/x", "/a~1b", "/a~1b/key", "/bad~2escape", ""} {
		err := validatePatch([]patchOperation{{Op: "set", Path: path, Value: json.RawMessage(`null`)}}, []string{"/account/tenant", "/a~1b/key"})
		if err == nil {
			t.Fatal("unsafe path accepted:", path)
		}
	}
	for _, path := range []string{"/id2", "/account/name", "/a~1b/name", "/ordinary~0name"} {
		if err := validatePatch([]patchOperation{{Op: "set", Path: path, Value: json.RawMessage(`null`)}}, []string{"/account/tenant", "/a~1b/key"}); err != nil {
			t.Fatal(path, err)
		}
	}
	calls := 0
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(500) }, true)
	r := testRequest()
	r.Operations = []patchOperation{{Op: "set", Path: "/status", Value: json.RawMessage(`"ok"`)}}
	if _, err := c.patchDocument(r); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatal(err)
	}
	c.readOnly = false
	for _, mutate := range []func(*request){func(r *request) { r.ETag = "" }, func(r *request) { r.ETag = "*" }, func(r *request) { r.Operations = make([]patchOperation, 11) }, func(r *request) { r.PartitionKey = nil }} {
		copy := r
		mutate(&copy)
		if _, err := c.patchDocument(copy); err == nil {
			t.Fatal("invalid patch accepted")
		}
	}
	if calls != 0 {
		t.Fatal("invalid patch touched network")
	}
}

func TestPatchRejectsContainerPartitionPathAfterMetadata(t *testing.T) {
	mutations := 0
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			mutations++
		}
		fmt.Fprint(w, `{"partitionKey":{"paths":["/scope/tenant"]}}`)
	}, false)
	r := testRequest()
	r.Operations = []patchOperation{{Op: "set", Path: "/scope", Value: json.RawMessage(`{}`)}}
	if _, err := c.patchDocument(r); err == nil || mutations != 0 {
		t.Fatal("partition parent patch accepted", err)
	}
}
