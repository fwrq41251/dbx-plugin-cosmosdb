package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const testKey = "dGVzdC1hY2NvdW50LWtleQ=="

func clientFor(t *testing.T, h http.HandlerFunc, readOnly bool) *cosmosClient {
	t.Helper()
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)
	c, err := newClient(s.URL, testKey, readOnly)
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func testRequest() request {
	return request{Database: "Db Case", Container: "Items", ID: "one", PageSize: 100, PartitionKey: json.RawMessage(`["tenant"]`), ETag: `"version-1"`}
}

func TestAuthorizationVector(t *testing.T) {
	got := authorization([]byte("test-account-key"), "GET", "dbs", "", "Thu, 27 Apr 2017 00:51:12 GMT")
	want := "type%3Dmaster%26ver%3D1.0%26sig%3D%2BCvihlmL3y9KzDlgTyjBacMpo86ohlk6nEdo7KcOmRs%3D"
	if got != want {
		t.Fatalf("authorization %q != %q", got, want)
	}
	if authorization([]byte("key"), "GET", "colls", "dbs/Case", "date") == authorization([]byte("key"), "GET", "colls", "dbs/case", "date") {
		t.Fatal("resource identifiers must preserve case")
	}
}
func TestEndpointValidation(t *testing.T) {
	for _, endpoint := range []string{"http://example.com", "https://u:p@example.com", "https://example.com/path", "https://example.com?a=b", "ftp://example.com"} {
		if _, err := newClient(endpoint, testKey, true); err == nil {
			t.Errorf("accepted %s", endpoint)
		}
	}
	if _, err := newClient("https://account.documents.azure.com/", "bad key", true); err == nil {
		t.Fatal("invalid key accepted")
	}
}
func TestQueryPaginationAndExactNumbers(t *testing.T) {
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.EscapedPath() != "/dbs/Db%20Case/colls/Items/docs" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.EscapedPath())
		}
		for k, want := range map[string]string{"Content-Type": "application/query+json", "x-ms-documentdb-isquery": "true", "x-ms-max-item-count": "100", "x-ms-continuation": "opaque-token", "x-ms-documentdb-partitionkey": "[\"tenant\"]"} {
			if r.Header.Get(k) != want {
				t.Errorf("%s=%q", k, r.Header.Get(k))
			}
		}
		key, _ := base64.StdEncoding.DecodeString(testKey)
		if r.Header.Get("Authorization") != authorization(key, "POST", "docs", "dbs/Db Case/colls/Items", r.Header.Get("x-ms-date")) {
			t.Error("bad signature")
		}
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		if string(body["parameters"]) != "[]" {
			t.Error("query parameters missing")
		}
		w.Header().Set("x-ms-request-charge", "2.81")
		w.Header().Set("x-ms-continuation", "next-token")
		fmt.Fprint(w, `{"Documents":[{"id":"one","large":9223372036854775807}]}`)
	}, true)
	r := testRequest()
	r.Query = "SELECT * FROM c"
	r.Continuation = "opaque-token"
	p, err := c.documents("cosmos/query", r)
	if err != nil {
		t.Fatal(err)
	}
	if p.RU != 2.81 || p.Continuation != "next-token" || !strings.Contains(p.JSON, "9223372036854775807") {
		t.Fatalf("bad page: %+v", p)
	}
	encoded, _ := json.Marshal(p)
	if strings.Contains(string(encoded), `"items"`) {
		t.Fatal("raw document parsed across host JSON boundary")
	}
}
func TestMetadataPagingAndParentSignature(t *testing.T) {
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dbs/Case/colls" {
			t.Error(r.URL.Path)
		}
		key, _ := base64.StdEncoding.DecodeString(testKey)
		if r.Header.Get("Authorization") != authorization(key, "GET", "colls", "dbs/Case", r.Header.Get("x-ms-date")) {
			t.Error("wrong parent signature")
		}
		fmt.Fprint(w, `{"DocumentCollections":[{"id":"Items","partitionKey":{"paths":["/tenant"]}}]}`)
	}, true)
	p, err := c.list("colls", "dbs/Case", "dbs/Case", "DocumentCollections", "", 100)
	if err != nil || !strings.Contains(p.JSON, "/tenant") {
		t.Fatalf("%+v %v", p, err)
	}
}
func TestReplacePreservesPrecisionStripsSystemFieldsAndUsesETag(t *testing.T) {
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/Items") {
			fmt.Fprint(w, `{"partitionKey":{"paths":["/tenant"]}}`)
			return
		}
		if r.Method != "PUT" || r.Header.Get("If-Match") != `"version-1"` {
			t.Error("missing conditional replace")
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "9223372036854775807") || strings.Contains(string(body), "_etag") {
			t.Errorf("unsafe payload %s", body)
		}
		fmt.Fprint(w, `{"id":"one","large":9223372036854775807,"_etag":"\"version-2\""}`)
	}, false)
	r := testRequest()
	r.Document = json.RawMessage(`{"id":"one","tenant":"tenant","large":9223372036854775807,"_etag":"old","_ts":123}`)
	if _, err := c.documents("cosmos/replace", r); err != nil {
		t.Fatal(err)
	}
}
func TestMutationValidationBeforeNetwork(t *testing.T) {
	var calls atomic.Int32
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }, true)
	for _, method := range []string{"cosmos/create", "cosmos/replace", "cosmos/delete"} {
		r := testRequest()
		r.Document = json.RawMessage(`{"id":"one"}`)
		if _, err := c.documents(method, r); err == nil {
			t.Errorf("read-only %s allowed", method)
		}
	}
	c.readOnly = false
	for _, mutate := range []func(*request){func(r *request) { r.ETag = "" }, func(r *request) { r.ETag = "*" }, func(r *request) { r.PartitionKey = nil }, func(r *request) { r.Document = json.RawMessage(`{"id":"another"}`) }} {
		r := testRequest()
		r.Document = json.RawMessage(`{"id":"one"}`)
		mutate(&r)
		if _, err := c.documents("cosmos/replace", r); err == nil {
			t.Error("invalid mutation passed")
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("%d unexpected network calls", calls.Load())
	}
}
func TestConflictAndThrottleAreNotRetried(t *testing.T) {
	for _, code := range []int{412, 429} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			var calls atomic.Int32
			c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/Items") {
					fmt.Fprint(w, `{"partitionKey":{"paths":["/tenant"]}}`)
					return
				}
				calls.Add(1)
				w.Header().Set("x-ms-activity-id", "activity")
				w.Header().Set("x-ms-retry-after-ms", "500")
				w.WriteHeader(code)
				fmt.Fprint(w, `{"message":"secret-bearing upstream message"}`)
			}, false)
			r := testRequest()
			_, err := c.documents("cosmos/delete", r)
			e, ok := err.(*serviceError)
			if !ok || e.status != code || e.activityID != "activity" || calls.Load() != 1 {
				t.Fatalf("%v calls %d", err, calls.Load())
			}
			if strings.Contains(err.Error(), "secret-bearing") {
				t.Fatal("leaked upstream body")
			}
		})
	}
}
func TestCreateAndDelete(t *testing.T) {
	for _, method := range []string{"cosmos/create", "cosmos/delete"} {
		t.Run(method, func(t *testing.T) {
			c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/Items") {
					fmt.Fprint(w, `{"partitionKey":{"paths":["/tenant"]}}`)
					return
				}
				if method == "cosmos/create" {
					if r.Method != "POST" || r.Header.Get("x-ms-documentdb-is-upsert") != "" {
						t.Error("create must not upsert")
					}
					w.WriteHeader(201)
					fmt.Fprint(w, `{"id":"one"}`)
				} else {
					if r.Method != "DELETE" || r.Header.Get("If-Match") == "" {
						t.Error("unsafe delete")
					}
					w.WriteHeader(204)
				}
			}, false)
			r := testRequest()
			r.Document = json.RawMessage(`{"id":"one","tenant":"tenant"}`)
			if _, err := c.documents(method, r); err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestSessionTokenForwarded(t *testing.T) {
	var count atomic.Int32
	c := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if count.Add(1) > 1 && r.Header.Get("x-ms-session-token") != "0:10" {
			t.Error("session token missing")
		}
		w.Header().Set("x-ms-session-token", "0:10")
		fmt.Fprint(w, `{"id":"one"}`)
	}, true)
	for range 2 {
		if _, err := c.documents("cosmos/read", testRequest()); err != nil {
			t.Fatal(err)
		}
	}
}
func TestPartitionKeys(t *testing.T) {
	for _, raw := range []string{`["tenant",42,null]`, `[{}]`, `[true]`} {
		if _, err := partitionHeader(json.RawMessage(raw)); err != nil {
			t.Error(err)
		}
	}
	for _, raw := range []string{`null`, `[]`, `"tenant"`, `[[1]]`, `[{"x":1}]`, `[1,2,3,4]`} {
		if _, err := partitionHeader(json.RawMessage(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}
func TestLifecycleSecretAndReadOnlyBoundary(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"Databases":[]}`) }))
	defer s.Close()
	p := &plugin{connections: make(map[string]*cosmosClient)}
	raw := json.RawMessage(fmt.Sprintf(`{"connection":{"id":"test","host":%q,"connection_secrets":{"account_key":%q},"external_config":{"read_only":false},"read_only":true}}`, s.URL, testKey))
	result, e := p.Handle(sdk.RequestContext{}, "connection/connect", raw, nil)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(result)
	if strings.Contains(string(b), testKey) {
		t.Fatal("key returned to UI")
	}
	if !p.connections["test"].readOnly {
		t.Fatal("host read-only flag ignored")
	}
	_, e = p.Handle(sdk.RequestContext{}, "connection/disconnect", json.RawMessage(`{"connection":{"id":"test"}}`), nil)
	if e != nil {
		t.Fatal(e)
	}
	_, e = p.Handle(sdk.RequestContext{}, "cosmos/info", json.RawMessage(`{"connectionId":"test"}`), nil)
	if e == nil || e.Code != -32010 {
		t.Fatal("disconnected connection retained")
	}
}

func TestDefaultContainerConnectionLifecycle(t *testing.T) {
	calls := 0
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/dbs/Shop/colls/Orders" || r.Method != "GET" {
			t.Errorf("unexpected account-level request: %s %s", r.Method, r.URL.Path)
		}
		fmt.Fprint(w, `{"id":"Orders","partitionKey":{"paths":["/tenant"]}}`)
	}))
	defer s.Close()
	p := &plugin{connections: make(map[string]*cosmosClient)}
	raw := json.RawMessage(fmt.Sprintf(`{"connection":{"id":"scoped","host":%q,"connection_secrets":{"account_key":%q},"external_config":{"database_id":"Shop","container_id":"Orders"}}}`, s.URL, testKey))
	call := func(method string, params json.RawMessage) any {
		t.Helper()
		result, err := p.Handle(sdk.RequestContext{}, method, params, nil)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	for _, method := range []string{"connection/test", "connection/connect"} {
		call(method, raw)
	}
	info := call("cosmos/info", json.RawMessage(`{"connectionId":"scoped"}`)).(map[string]any)
	if info["database"] != "Shop" || info["container"] != "Orders" || info["readOnly"] != true {
		t.Fatal(info)
	}
	databases := call("cosmos/databases", json.RawMessage(`{"connectionId":"scoped"}`)).(page)
	if databases.JSON != `[{"id":"Shop"}]` {
		t.Fatal(databases)
	}
	containers := call("cosmos/containers", json.RawMessage(`{"connectionId":"scoped","database":"Shop"}`)).(page)
	if !strings.Contains(containers.JSON, `"id":"Orders"`) {
		t.Fatal(containers)
	}
	if calls != 3 {
		t.Fatalf("unexpected requests %d", calls)
	}
	call("connection/disconnect", json.RawMessage(`{"connection":{"id":"scoped"}}`))
	call("connection/connect", raw)
	if p.connections["scoped"].container != "Orders" {
		t.Fatal("reconnect lost scope")
	}
	for _, config := range []string{`{"database_id":"Shop"}`, `{"container_id":"Orders"}`, `{"database_id":"/bad","container_id":"Orders"}`} {
		invalid := json.RawMessage(fmt.Sprintf(`{"connection":{"id":"bad","host":%q,"connection_secrets":{"account_key":%q},"external_config":%s}}`, s.URL, testKey, config))
		if _, err := p.Handle(sdk.RequestContext{}, "connection/connect", invalid, nil); err == nil {
			t.Fatal("invalid scope accepted")
		}
	}
}
