package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestSeekSkipsDuplicateKeysAndPreservesTypedBoundaries(t *testing.T) {
	queries, metadata := 0, 0
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-ms-request-charge", "2")
		if strings.HasSuffix(r.URL.Path, "/Items") {
			metadata++
			fmt.Fprint(w, `{"partitionKey":{"paths":["/a~1b"]}}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/pkranges") {
			fmt.Fprint(w, `{"PartitionKeyRanges":[{"id":"0"},{"id":"1"}]}`)
			return
		}
		queries++
		if r.Header.Get("x-ms-max-item-count") != "1" || r.Header.Get("x-ms-documentdb-partitionkeyrangeid") == "" {
			t.Fatal("unbounded or unrouted seek")
		}
		var body struct {
			Query      string      `json:"query"`
			Parameters []parameter `json:"parameters"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if strings.Contains(body.Query, "DISTINCT") || !strings.Contains(body.Query, `c["a/b"]`) {
			t.Fatal(body.Query)
		}
		if r.Header.Get("x-ms-documentdb-partitionkeyrangeid") == "1" {
			fmt.Fprint(w, `{"Documents":[]}`)
			return
		}
		switch queries {
		case 1:
			fmt.Fprint(w, `{"Documents":[{"k0":"alpha"}]}`)
		case 2:
			if len(body.Parameters) != 1 || string(body.Parameters[0].Value) != `"alpha"` || !strings.Contains(body.Query, "> @after") {
				t.Fatal("missing strict bound", body)
			}
			w.Header().Set("x-ms-continuation", "empty-page")
			fmt.Fprint(w, `{"Documents":[]}`)
		case 3:
			if r.Header.Get("x-ms-continuation") != "empty-page" {
				t.Fatal("empty page was skipped")
			}
			fmt.Fprint(w, `{"Documents":[{"k0":"omega"}]}`)
		case 4:
			if string(body.Parameters[0].Value) != `"omega"` || r.Header.Get("x-ms-continuation") != "" {
				t.Fatal("old query cursor leaked")
			}
			fmt.Fprint(w, `{"Documents":[]}`)
		case 5:
			fmt.Fprint(w, `{"Documents":[{"k0":9223372036854775807}]}`)
		case 6:
			if string(body.Parameters[0].Value) != "9223372036854775807" || !strings.Contains(body.Query, "IS_NUMBER") {
				t.Fatal("number rounded or wrong phase")
			}
			fmt.Fprint(w, `{"Documents":[]}`)
		case 7:
			fmt.Fprint(w, `{"Documents":[{"k0":false}]}`)
		case 8:
			fmt.Fprint(w, `{"Documents":[{"k0":true}]}`)
		case 9:
			fmt.Fprint(w, `{"Documents":[{"k0":null}]}`)
		case 10:
			fmt.Fprint(w, `{"Documents":[{"found":1}]}`)
		default:
			t.Fatal("unexpected query")
		}
	}, true)
	r := testRequest()
	r.DiscoveryMode = "seek"
	keys := map[string]bool{}
	for i := 0; i < 20; i++ {
		p, err := c.seekPartitionKeys(r)
		if err != nil {
			t.Fatal(err)
		}
		for _, k := range p.Keys {
			keys[k] = true
		}
		if p.RU > 6 {
			t.Fatal("unexpected query budget", p.RU)
		}
		r.Continuation = p.Continuation
		if p.Continuation == "" {
			break
		}
	}
	if metadata != 1 || queries != 16 || len(keys) != 7 {
		t.Fatalf("metadata=%d queries=%d keys=%v", metadata, queries, keys)
	}
	for _, key := range []string{`["alpha"]`, `["omega"]`, `[9223372036854775807]`, `[false]`, `[true]`, `[null]`, `[{}]`} {
		if !keys[key] {
			t.Fatal("missing", key)
		}
	}
}
