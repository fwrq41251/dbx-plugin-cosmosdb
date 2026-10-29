package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestStructuredErrorPreservesWireContract(t *testing.T) {
	original := reasonError("cosmos.queryRequired", "Query is required")
	for _, err := range []error{original, fmt.Errorf("wrapped: %w", original)} {
		wire := rpcError(err)
		if wire.Code != -32602 || wire.Message != err.Error() {
			t.Fatalf("legacy contract changed: %#v", wire)
		}
		b, _ := json.Marshal(wire.Data)
		var detail reasonDetail
		if json.Unmarshal(b, &detail) != nil || detail.Reason != "cosmos.queryRequired" {
			t.Fatalf("missing reason: %s", b)
		}
	}
	cancel := rpcError(fmt.Errorf("wrapped: %w", context.Canceled))
	if cancel.Code != -32800 || errorDetail(context.Canceled).Reason != "main.queryCanceled" {
		t.Fatal(cancel)
	}
	unknown := rpcError(errors.New("foreign SDK diagnostic"))
	if unknown.Message != "foreign SDK diagnostic" || errorDetail(errors.New("Query is required")).Reason != "internal.failure" {
		t.Fatal("inferred reason from text")
	}
}

func TestStructuredServiceErrorKeepsSanitizedMetadata(t *testing.T) {
	err := classifyServiceError(400, []byte(`{"errors":[{"code":"SC1001","message":"syntax error secret-document-value","location":{"start":9}}]}`), "")
	wire := rpcError(err)
	data := wire.Data.(map[string]any)
	if data["reason"] != "cosmos.sql-syntax-position" || data["position"] != 9 || data["category"] != "sql-syntax" {
		t.Fatal(data)
	}
	args := data["args"].([]any)
	if len(args) != 1 || args[0] != 10 || wire.Code != -32000 {
		t.Fatal(data)
	}
	result := mcpFailure(err)
	text := result["content"].([]any)[0].(map[string]any)["text"].(string)
	var value map[string]any
	_ = json.Unmarshal([]byte(text), &value)
	if result["isError"] != true || value["error"] != err.Error() || value["reason"] != "cosmos.sql-syntax-position" || value["status"] != float64(400) {
		t.Fatal(value)
	}
	if strings.Contains(text, "secret-document-value") {
		t.Fatal("raw upstream text leaked")
	}
}
