package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestSamplePartitionKeysOnlyReturnsTypedKeys(t *testing.T) {
	calls := 0
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("x-ms-request-charge", "2")
		if r.URL.Path == "/dbs/Db Case/colls/Items" {
			fmt.Fprint(w, `{"partitionKey":{"paths":["/tenant","/n"]}}`)
			return
		}
		if r.Method != "GET" || r.Header.Get("x-ms-max-item-count") != "100" {
			t.Error("sampling must use bounded read feed")
		}
		w.Header().Set("x-ms-continuation", "feed-next")
		fmt.Fprint(w, `{"Documents":[{"tenant":"alpha","n":9223372036854775807,"private":"must not escape"},{"tenant":"alpha","n":9223372036854775807},{"tenant":null,"n":false},{"n":1}]}`)
	}, true)
	r := testRequest()
	p, err := c.partitionKeys(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Keys) != 3 || p.Scanned != 4 || p.RU != 4 || p.Continuation == "" || calls != 2 {
		t.Fatalf("unexpected sample: %+v calls=%d", p, calls)
	}
	b, _ := json.Marshal(p)
	if strings.Contains(string(b), "must not escape") || !strings.Contains(string(b), "9223372036854775807") {
		t.Fatal("unsafe partition result")
	}
	if !strings.Contains(strings.Join(p.Keys, " "), `[{},1]`) {
		t.Fatal("undefined component lost")
	}
}

func TestDistinctPartitionKeysPageAcrossPhysicalRanges(t *testing.T) {
	queryCalls := 0
	rangeCalls := 0
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/dbs/Db Case/colls/Items":
			w.Header().Set("x-ms-request-charge", "1")
			fmt.Fprint(w, `{"partitionKey":{"paths":["/a~1b/~0name"]}}`)
		case strings.HasSuffix(r.URL.Path, "/pkranges"):
			rangeCalls++
			w.Header().Set("x-ms-request-charge", "2")
			fmt.Fprint(w, `{"PartitionKeyRanges":[{"id":"0"},{"id":"1"}]}`)
		default:
			queryCalls++
			w.Header().Set("x-ms-request-charge", "3")
			if r.Method != "POST" || r.Header.Get("x-ms-documentdb-isquery") != "true" || r.Header.Get("x-ms-documentdb-query-iscontinuationexpected") != "true" {
				t.Error("wrong discovery query headers")
			}
			var body struct {
				Query string `json:"query"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if queryCalls <= 3 && body.Query != `SELECT DISTINCT c["a/b"]["~name"] AS k0 FROM c ORDER BY c["a/b"]["~name"]` {
				t.Error(body.Query)
			}
			switch queryCalls {
			case 1:
				if r.Header.Get("x-ms-documentdb-partitionkeyrangeid") != "0" {
					t.Error("wrong range")
				}
				w.Header().Set("x-ms-continuation", "opaque-token")
				fmt.Fprint(w, `{"Documents":[]}`)
			case 2:
				if r.Header.Get("x-ms-continuation") != "opaque-token" {
					t.Error("token not forwarded")
				}
				fmt.Fprint(w, `{"Documents":[{"k0":"alpha"},{"k0":null}]}`)
			case 3:
				if r.Header.Get("x-ms-documentdb-partitionkeyrangeid") != "1" || r.Header.Get("x-ms-continuation") != "" {
					t.Error("range transition reused token")
				}
				fmt.Fprint(w, `{"Documents":[{"k0":"alpha"},{"k0":9223372036854775807}]}`)
			case 4:
				if !strings.Contains(body.Query, "NOT IS_DEFINED") {
					t.Error("missing undefined-value probe")
				}
				fmt.Fprint(w, `{"Documents":[]}`)
			case 5:
				if r.Header.Get("x-ms-documentdb-partitionkeyrangeid") != "1" {
					t.Error("probe skipped a range")
				}
				fmt.Fprint(w, `{"Documents":[{"found":1}]}`)
			}
		}
	}, true)
	r := testRequest()
	r.DiscoveryMode = "distinct"
	for i := 0; i < 5; i++ {
		p, err := c.partitionKeys(r)
		if err != nil {
			t.Fatal(err)
		}
		wantRU := 4.0
		if i == 0 {
			wantRU = 6
		}
		if p.RU != wantRU {
			t.Errorf("RU=%v want=%v", p.RU, wantRU)
		}
		if i < 4 && p.Continuation == "" {
			t.Fatal("lost continuation or empty-page cursor")
		}
		if i == 4 && (p.Continuation != "" || len(p.Keys) != 1 || p.Keys[0] != "[{}]") {
			t.Fatal("final page not finished")
		}
		r.Continuation = p.Continuation
	}
	if rangeCalls != 1 || queryCalls != 5 {
		t.Fatalf("metadata unexpectedly rescanned: ranges %d queries %d", rangeCalls, queryCalls)
	}
}

func TestPartitionCursorScopeAndPageBounds(t *testing.T) {
	c, err := newClient("https://example.com", testKey, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*request){
		func(r *request) { r.PageSize = 101 },
		func(r *request) { r.DiscoveryMode = "unknown" },
		func(r *request) { r.Continuation = "not base64" },
		func(r *request) {
			b, _ := json.Marshal(keyCursor{Database: "other", Container: r.Container, Mode: "sample"})
			r.Continuation = base64.RawURLEncoding.EncodeToString(b)
		},
	} {
		r := testRequest()
		mutate(&r)
		if _, err := c.partitionKeys(r); err == nil {
			t.Fatal("bad discovery request accepted")
		}
	}
}
func TestPartitionKeyJSONPointerAndScalars(t *testing.T) {
	for _, tc := range []struct {
		doc   string
		paths []string
		want  string
	}{
		{`{"a/b":{"~c":false},"n":null}`, []string{"/a~1b/~0c", "/n", "/missing"}, `[false,null,{}]`},
		{`{"n":9223372036854775807}`, []string{"/n"}, `[9223372036854775807]`},
		{`{"n":1.234567890123456789}`, []string{"/n"}, `[1.234567890123456789]`},
		{`{"n":{"x":1}}`, []string{"/n"}, `[{}]`},
		{`{}`, nil, `[{}]`},
	} {
		got, err := partitionKeyFor(json.RawMessage(tc.doc), tc.paths)
		if err != nil || got != tc.want {
			t.Fatalf("%s %v want %s", got, err, tc.want)
		}
	}
}
