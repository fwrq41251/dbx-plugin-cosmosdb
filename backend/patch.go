package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

type patchOperation struct {
	Op    string          `json:"op"`
	Path  string          `json:"path"`
	Value json.RawMessage `json:"value,omitempty"`
}

func patchTokens(path string) ([]string, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, reasonError("patch.invalidPointer", "Patch 路径必须是以 / 开头的 JSON Pointer")
	}
	parts := strings.Split(path[1:], "/")
	for i, p := range parts {
		for j := 0; j < len(p); j++ {
			if p[j] == '~' {
				if j+1 == len(p) || (p[j+1] != '0' && p[j+1] != '1') {
					return nil, reasonError("patch.invalidEscape", "Patch 路径的 ~ 必须转义为 ~0 或 ~1")
				}
				j++
			}
		}
		parts[i] = strings.ReplaceAll(strings.ReplaceAll(p, "~1", "/"), "~0", "~")
	}
	return parts, nil
}
func relatedPath(a, b []string) bool {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
func validatePatch(operations []patchOperation, paths []string) error {
	if len(operations) < 1 || len(operations) > 10 {
		return reasonError("patch.operationCount", "局部更新必须包含 1–10 个操作；请减少改动，或明确选择完整替换")
	}
	protected := [][]string{{"id"}, {"_rid"}, {"_self"}, {"_etag"}, {"_attachments"}, {"_ts"}}
	for _, path := range paths {
		p, err := partitionPath(path)
		if err != nil {
			return err
		}
		protected = append(protected, p)
	}
	for _, op := range operations {
		if op.Op != "set" && op.Op != "remove" {
			return reasonError("patch.unsupportedOperation", "仅支持 set 和 remove 局部更新操作")
		}
		parts, err := patchTokens(op.Path)
		if err != nil {
			return err
		}
		for _, path := range protected {
			if relatedPath(parts, path) {
				return reasonError("patch.protectedPath", "局部更新不能修改 id、分区键、它们的父子路径或系统字段")
			}
		}
		if op.Op == "set" && (len(op.Value) == 0 || !json.Valid(op.Value)) {
			return reasonError("patch.invalidSetValue", "set 操作必须包含有效的 JSON 值，空值请使用 null")
		}
		if op.Op == "remove" && len(op.Value) != 0 {
			return reasonError("patch.unexpectedRemoveValue", "remove 操作不能包含 value")
		}
	}
	return nil
}
func (c *cosmosClient) patchDocument(r request) (page, error) {
	if c.readOnly {
		return page{}, reasonError("patch.readOnly", "Connection is read-only. 请关闭保存连接中的只读设置后重新连接，并使用可写凭据")
	}
	if err := validID(r.ID); err != nil {
		return page{}, err
	}
	pk, err := partitionHeader(r.PartitionKey)
	if err != nil {
		return page{}, err
	}
	if pk == "" {
		return page{}, reasonError("patch.partitionRequired", "局部更新需要明确的完整分区键")
	}
	if r.ETag == "" || r.ETag == "*" {
		return page{}, reasonError("patch.etagRequired", "请先读取完整文档：局部更新需要其 ETag 以检查并发冲突")
	}
	if err = validatePatch(r.Operations, nil); err != nil {
		return page{}, err
	}
	meta, err := c.containerMetadata(r.Database, r.Container)
	if err != nil {
		return page{}, err
	}
	var container struct {
		PartitionKey struct {
			Paths []string `json:"paths"`
		} `json:"partitionKey"`
	}
	if json.Unmarshal(meta.Items, &container) != nil {
		return page{}, reasonError("partitions.invalidMetadata", "Invalid container metadata")
	}
	if err = validatePatch(r.Operations, container.PartitionKey.Paths); err != nil {
		return page{}, err
	}
	var components []json.RawMessage
	_ = json.Unmarshal(r.PartitionKey, &components)
	expected := len(container.PartitionKey.Paths)
	if expected == 0 {
		expected = 1
	}
	if len(components) != expected {
		return page{}, reasonError("patch.componentCount", "分区键组件数量与容器定义不一致")
	}
	etag, _ := json.Marshal(r.ETag)
	body, _ := json.Marshal(map[string]any{"operations": r.Operations, "condition": "from c where c._etag = " + string(etag)})
	h := http.Header{}
	h.Set("Content-Type", "application/json_patch+json")
	h.Set("x-ms-documentdb-partitionkey", pk)
	h.Set("If-Match", r.ETag)
	link := "dbs/" + r.Database + "/colls/" + r.Container
	p, err := c.request("PATCH", "docs", link+"/docs/"+r.ID, resourcePath("dbs", r.Database, "colls", r.Container, "docs", r.ID), body, h, link)
	p.RU += meta.RU
	return p, err
}
