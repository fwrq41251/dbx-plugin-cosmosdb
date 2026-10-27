package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestServiceErrorsClassifyWithoutLeakingUpstreamValues(t *testing.T) {
	nested, _ := json.Marshal(map[string]any{"message": `{"errors":[{"code":"SC1001","location":{"start":14},"message":"Syntax error near secret-upstream-value"}]}`})
	for _, tc := range []struct {
		status                    int
		body                      []byte
		substatus, category, hint string
	}{
		{400, nested, "", "sql-syntax", "第 15 个字符"},
		{400, []byte(`{"message":"partition key extracted from document does not match secret-upstream-value"}`), "1001", "partition-key", "分区键不匹配"},
		{400, []byte(`{"message":"Cross partition query can not be directly served by the gateway secret-upstream-value"}`), "", "query-pipeline", "SDK"},
		{400, []byte(`{"message":"The order by query does not have a corresponding composite index secret-upstream-value"}`), "", "index", "索引"},
		{400, []byte(`{"message":"Patch path missing secret-upstream-value"}`), "", "patch", "局部更新"},
		{403, []byte(`{"message":"account key is read only secret-upstream-value"}`), "", "write-permission", "可写 Account Key"},
		{403, []byte(`{"message":"firewall rejected IP address secret-upstream-value"}`), "", "network-access", "网络访问"},
		{412, []byte(`{"message":"secret-upstream-value"}`), "", "concurrency", "并发冲突"},
	} {
		e := classifyServiceError(tc.status, tc.body, tc.substatus)
		if e.category != tc.category || !strings.Contains(e.Error(), tc.hint) || strings.Contains(e.Error(), "secret-upstream-value") {
			t.Fatalf("%+v: %s", e, e.Error())
		}
		encoded, _ := json.Marshal(rpcError(e))
		if strings.Contains(string(encoded), "secret-upstream-value") {
			t.Fatal("upstream value leaked to bridge")
		}
	}
}
