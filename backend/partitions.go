package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type keyPage struct {
	Keys         []string `json:"keys"` // JSON text preserves component types and numeric precision.
	Continuation string   `json:"continuation"`
	Mode         string   `json:"mode"`
	Scanned      int      `json:"scanned"`
	RU           float64  `json:"ru"`
	DurationMS   int64    `json:"durationMs"`
	CacheWarning string   `json:"cacheWarning,omitempty"`
}
type keyCursor struct {
	Database  string   `json:"database"`
	Container string   `json:"container"`
	Mode      string   `json:"mode"`
	Ranges    []string `json:"ranges,omitempty"`
	Range     int      `json:"range,omitempty"`
	Token     string   `json:"token,omitempty"`
	Missing   bool     `json:"missing,omitempty"`
}

func (c *cosmosClient) containerMetadata(database, container string) (page, error) {
	return c.request("GET", "colls", "dbs/"+database+"/colls/"+container, resourcePath("dbs", database, "colls", container), nil, nil, "")
}

func (c *cosmosClient) partitionKeys(r request) (keyPage, error) {
	start := time.Now()
	mode := r.DiscoveryMode
	if mode == "" {
		mode = "sample"
	}
	if mode != "sample" && mode != "distinct" {
		return keyPage{}, errors.New("Unknown partition discovery mode")
	}
	// Keep each RPC bounded to one page; the UI owns automatic paging and pause.
	if r.PageSize > 100 {
		return keyPage{}, errors.New("Partition discovery page size cannot exceed 100")
	}
	cursor := keyCursor{Database: r.Database, Container: r.Container, Mode: mode}
	if r.Continuation != "" {
		if len(r.Continuation) > 128*1024 {
			return keyPage{}, errors.New("Partition cursor is too large")
		}
		data, err := base64.RawURLEncoding.DecodeString(r.Continuation)
		if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Database != r.Database || cursor.Container != r.Container || cursor.Mode != mode {
			return keyPage{}, errors.New("Partition cursor does not match this container and discovery mode; refresh candidates")
		}
	}
	link := "dbs/" + r.Database + "/colls/" + r.Container
	parent := resourcePath("dbs", r.Database, "colls", r.Container)
	meta, err := c.request("GET", "colls", link, parent, nil, nil, "")
	if err != nil {
		return keyPage{}, err
	}
	var container struct {
		PartitionKey struct {
			Paths []string `json:"paths"`
		} `json:"partitionKey"`
	}
	if json.Unmarshal(meta.Items, &container) != nil {
		return keyPage{}, errors.New("Invalid container metadata")
	}
	paths := container.PartitionKey.Paths
	if len(paths) > 3 {
		return keyPage{}, errors.New("Unsupported partition key definition")
	}
	ru := meta.RU
	h := http.Header{}
	h.Set("x-ms-max-item-count", strconv.Itoa(r.PageSize))
	if cursor.Token != "" {
		h.Set("x-ms-continuation", cursor.Token)
	}
	var p page
	if mode == "sample" {
		p, err = c.request("GET", "docs", link, parent+"/docs", nil, h, link)
	} else {
		if len(paths) != 1 {
			return keyPage{}, errors.New("Full enumeration currently supports one partition path. Use sampling or manual input for hierarchical keys")
		}
		expression, exprErr := partitionExpression(paths[0])
		if exprErr != nil {
			return keyPage{}, exprErr
		}
		if r.Continuation == "" {
			var rangeRU float64
			cursor.Ranges, rangeRU, err = c.partitionRanges(link, parent)
			ru += rangeRU
			if err != nil {
				return keyPage{}, err
			}
		}
		if len(cursor.Ranges) == 0 || len(cursor.Ranges) > 32000 || cursor.Range < 0 || cursor.Range >= len(cursor.Ranges) {
			return keyPage{}, errors.New("Invalid physical partition cursor; refresh candidates")
		}
		if err = validID(cursor.Ranges[cursor.Range]); err != nil {
			return keyPage{}, err
		}
		h.Set("x-ms-documentdb-partitionkeyrangeid", cursor.Ranges[cursor.Range])
		h.Set("x-ms-documentdb-isquery", "true")
		h.Set("x-ms-documentdb-query-iscontinuationexpected", "true")
		h.Set("Content-Type", "application/query+json")
		query := "SELECT DISTINCT " + expression + " AS k0 FROM c ORDER BY " + expression
		if cursor.Missing {
			// ORDER BY may omit undefined values depending on the indexing policy.
			query = "SELECT TOP 1 1 AS found FROM c WHERE NOT IS_DEFINED(" + expression + ") OR IS_OBJECT(" + expression + ") OR IS_ARRAY(" + expression + ")"
		}
		body, _ := json.Marshal(map[string]any{"query": query, "parameters": []any{}})
		p, err = c.request("POST", "docs", link, parent+"/docs", body, h, "")
	}
	if err != nil {
		return keyPage{}, err
	}
	p, err = unwrap(p, "Documents")
	if err != nil {
		return keyPage{}, err
	}
	var documents []json.RawMessage
	if json.Unmarshal(p.Items, &documents) != nil {
		return keyPage{}, errors.New("Invalid partition discovery results")
	}
	isMissingPage := cursor.Missing
	keys := make(map[string]bool)
	for _, doc := range documents {
		var key string
		if cursor.Missing {
			key = "[{}]"
		} else if mode == "sample" {
			key, err = partitionKeyFor(doc, paths)
		} else {
			key, err = partitionKeyFor(doc, []string{"/k0"})
		}
		if err != nil {
			return keyPage{}, err
		}
		keys[key] = true
	}
	result := keyPage{Keys: make([]string, 0, len(keys)), Mode: mode, Scanned: len(documents), RU: ru + p.RU, DurationMS: time.Since(start).Milliseconds()}
	for key := range keys {
		result.Keys = append(result.Keys, key)
	}
	sort.Strings(result.Keys)
	cursor.Token = p.Continuation
	more := cursor.Token != ""
	if mode == "distinct" && !more {
		cursor.Range++
		if cursor.Range == len(cursor.Ranges) && !cursor.Missing {
			cursor.Missing = true
			cursor.Range = 0
		}
		more = cursor.Range < len(cursor.Ranges)
	}
	if isMissingPage && len(documents) > 0 {
		more = false
	}
	if more {
		data, _ := json.Marshal(cursor)
		result.Continuation = base64.RawURLEncoding.EncodeToString(data)
	}
	return result, nil
}

func (c *cosmosClient) partitionRanges(link, parent string) ([]string, float64, error) {
	var ids []string
	var ru float64
	token := ""
	seen := map[string]bool{}
	for range 32 {
		p, err := c.list("pkranges", link, parent, "PartitionKeyRanges", token, 1000)
		if err != nil {
			return nil, ru, err
		}
		ru += p.RU
		var ranges []struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(p.Items, &ranges) != nil {
			return nil, ru, errors.New("Invalid physical partition ranges")
		}
		for _, r := range ranges {
			if validID(r.ID) != nil {
				return nil, ru, errors.New("Invalid physical partition id")
			}
			ids = append(ids, r.ID)
		}
		token = p.Continuation
		if token == "" {
			return ids, ru, nil
		}
		if seen[token] {
			return nil, ru, errors.New("Repeated physical partition continuation")
		}
		seen[token] = true
	}
	return nil, ru, errors.New("Too many physical partition ranges for candidate enumeration")
}

func partitionExpression(path string) (string, error) {
	parts, err := partitionPath(path)
	if err != nil {
		return "", err
	}
	s := "c"
	for _, part := range parts {
		encoded, _ := json.Marshal(part)
		s += "[" + string(encoded) + "]"
	}
	return s, nil
}
func partitionPath(path string) ([]string, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, errors.New("Invalid partition path")
	}
	parts := strings.Split(path[1:], "/")
	for i, p := range parts {
		parts[i] = strings.ReplaceAll(strings.ReplaceAll(p, "~1", "/"), "~0", "~")
	}
	return parts, nil
}
func partitionKeyFor(document json.RawMessage, paths []string) (string, error) {
	values := make([]json.RawMessage, 0, len(paths))
	for _, path := range paths {
		parts, err := partitionPath(path)
		if err != nil {
			return "", err
		}
		value := document
		for _, part := range parts {
			var object map[string]json.RawMessage
			if json.Unmarshal(value, &object) != nil {
				value = nil
				break
			}
			value = object[part]
			if len(value) == 0 {
				break
			}
		}
		trimmed := bytes.TrimSpace(value)
		if len(trimmed) == 0 || trimmed[0] == '{' || trimmed[0] == '[' {
			trimmed = json.RawMessage(`{}`)
		}
		values = append(values, trimmed)
	}
	if len(values) == 0 {
		values = append(values, json.RawMessage(`{}`))
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return "", fmt.Errorf("Invalid partition value: %w", err)
	}
	return string(encoded), nil
}
