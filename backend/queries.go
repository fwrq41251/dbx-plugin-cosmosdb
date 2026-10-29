package main

import (
	"context"
	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	"time"
)

type queryJob struct {
	cancel  context.CancelFunc
	done    bool
	expires time.Time
}

func queryKey(connection, id string) (string, error) {
	if id == "" || len(id) > 128 {
		return "", reasonError("queries.invalidId", "A bounded queryId is required")
	}
	return connection + "\x00" + id, nil
}

func (p *plugin) beginQuery(connection, id string) (context.Context, func(), error) {
	key, err := queryKey(connection, id)
	if err != nil {
		return nil, nil, err
	}
	p.queriesMu.Lock()
	defer p.queriesMu.Unlock()
	if p.queries == nil {
		p.queries = make(map[string]*queryJob)
	}
	for k, j := range p.queries {
		if j.done && time.Now().After(j.expires) {
			delete(p.queries, k)
		}
	}
	if j, ok := p.queries[key]; ok {
		if j.done {
			return nil, nil, context.Canceled
		}
		return nil, nil, reasonError("queries.alreadyRunning", "Query id is already running")
	}
	if len(p.queries) >= 1024 {
		return nil, nil, reasonError("queries.capacity", "Too many recent queries; retry later")
	}
	ctx, cancel := context.WithCancel(context.Background())
	job := &queryJob{cancel: cancel}
	p.queries[key] = job
	return ctx, func() {
		cancel()
		p.queriesMu.Lock()
		job.done = true
		job.expires = time.Now().Add(time.Minute)
		p.queriesMu.Unlock()
	}, nil
}

func (p *plugin) cancelQuery(connection, id string) (any, *sdk.PluginError) {
	key, err := queryKey(connection, id)
	if err != nil {
		return nil, rpcError(err)
	}
	p.queriesMu.Lock()
	defer p.queriesMu.Unlock()
	if p.queries == nil {
		p.queries = make(map[string]*queryJob)
	}
	for k, j := range p.queries {
		if j.done && time.Now().After(j.expires) {
			delete(p.queries, k)
		}
	}
	if j := p.queries[key]; j != nil {
		if j.cancel != nil {
			j.cancel()
		}
		return map[string]any{"canceled": true}, nil
	}
	// SDK requests are concurrent: cancellation can arrive before registration.
	if len(p.queries) >= 1024 {
		return nil, rpcReason(-32602, "queries.retryCapacity", "Too many recent queries")
	}
	p.queries[key] = &queryJob{done: true, expires: time.Now().Add(time.Minute)}
	return map[string]any{"canceled": true}, nil
}
