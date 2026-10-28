package main

import (
	"context"
	"encoding/json"
	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestQueryCancelReachesHTTPAndIsConnectionScoped(t *testing.T) {
	started := make(chan struct{})
	aborted := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
			return
		}
		close(aborted)
	}))
	defer s.Close()
	c, _ := newClient(s.URL, "dGVzdC1hY2NvdW50LWtleQ==", true)
	p := &plugin{connections: map[string]*cosmosClient{"one": c, "two": c}}
	done := make(chan *sdk.PluginError, 1)
	go func() {
		_, e := p.Handle(sdk.RequestContext{}, "cosmos/query", json.RawMessage(`{"connectionId":"one","database":"Shop","container":"Orders","query":"SELECT * FROM c","queryId":"q1"}`), nil)
		done <- e
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("query did not reach service")
	}
	_, _ = p.cancelQuery("two", "q1")
	select {
	case <-done:
		t.Fatal("another connection canceled this query")
	case <-time.After(30 * time.Millisecond):
	}
	_, _ = p.cancelQuery("one", "q1")
	select {
	case e := <-done:
		if e == nil || e.Code != -32800 {
			t.Fatal(e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not return")
	}
	select {
	case <-aborted:
	case <-time.After(2 * time.Second):
		t.Fatal("HTTP context was not canceled")
	}
}

func TestQueryCancelBeforeRegistrationAndLimit(t *testing.T) {
	p := &plugin{}
	_, _ = p.cancelQuery("one", "early")
	if _, _, err := p.beginQuery("one", "early"); err != context.Canceled {
		t.Fatal(err)
	}
	_, finish, err := p.beginQuery("one", "normal")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = p.beginQuery("one", "normal"); err == nil {
		t.Fatal("duplicate active id accepted")
	}
	finish()
	if _, _, err = p.beginQuery("one", "normal"); err != context.Canceled {
		t.Fatal(err)
	}
}
