package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"time"
)

type seekCursor struct {
	Version   int             `json:"version"`
	Database  string          `json:"database"`
	Container string          `json:"container"`
	Paths     []string        `json:"paths"`
	Ranges    []string        `json:"ranges"`
	Range     int             `json:"range"`
	Phase     int             `json:"phase"`
	After     json.RawMessage `json:"after,omitempty"`
	Token     string          `json:"token,omitempty"`
}

// Seek to one different indexed scalar value per RPC instead of scanning its
// duplicates. Each physical range is visited independently, then the UI dedups.
func (c *cosmosClient) seekPartitionKeys(r request) (keyPage, error) {
	start := time.Now()
	result := keyPage{Keys: []string{}, Mode: "seek"}
	cur := seekCursor{Version: 1, Database: r.Database, Container: r.Container}
	link := "dbs/" + r.Database + "/colls/" + r.Container
	parent := resourcePath("dbs", r.Database, "colls", r.Container)
	if r.Continuation == "" {
		meta, err := c.containerMetadata(r.Database, r.Container)
		if err != nil {
			return result, err
		}
		result.RU += meta.RU
		var container struct {
			PartitionKey struct {
				Paths []string `json:"paths"`
			} `json:"partitionKey"`
		}
		if json.Unmarshal(meta.Items, &container) != nil {
			return result, errors.New("Invalid container metadata")
		}
		cur.Paths = container.PartitionKey.Paths
		if len(cur.Paths) != 1 {
			return result, errors.New("索引跳读目前支持单路径分区键；此容器请使用已知候选或手动输入，不会自动扫描文档")
		}
		var ru float64
		cur.Ranges, ru, err = c.partitionRanges(link, parent)
		result.RU += ru
		if err != nil {
			return result, err
		}
	} else {
		if len(r.Continuation) > 128*1024 {
			return result, errors.New("Partition cursor is too large")
		}
		data, err := base64.RawURLEncoding.DecodeString(r.Continuation)
		if err != nil || json.Unmarshal(data, &cur) != nil || cur.Version != 1 || cur.Database != r.Database || cur.Container != r.Container {
			return result, errors.New("Invalid seek cursor; refresh the partition list")
		}
	}
	if len(cur.Paths) != 1 || len(cur.Ranges) == 0 || len(cur.Ranges) > 32000 || cur.Range < 0 || cur.Range >= len(cur.Ranges) || cur.Phase < 0 || cur.Phase > 5 {
		return result, errors.New("Invalid seek cursor state; refresh the partition list")
	}
	if err := validID(cur.Ranges[cur.Range]); err != nil {
		return result, err
	}
	expr, err := partitionExpression(cur.Paths[0])
	if err != nil {
		return result, err
	}
	parameters := []parameter{}
	query := "SELECT TOP 1 " + expr + " AS k0 FROM c WHERE "
	switch cur.Phase {
	case 0, 1:
		kind := "IS_STRING"
		if cur.Phase == 1 {
			kind = "IS_NUMBER"
		}
		query += kind + "(" + expr + ")"
		if len(cur.After) > 0 {
			var value any
			if json.Unmarshal(cur.After, &value) != nil || (cur.Phase == 0 && !isJSONString(cur.After)) || (cur.Phase == 1 && !isJSONNumber(cur.After)) {
				return result, errors.New("Invalid typed seek boundary")
			}
			query += " AND " + expr + " > @after"
			parameters = append(parameters, parameter{Name: "@after", Value: cur.After})
		}
		query += " ORDER BY " + expr
	case 2:
		query += expr + " = false"
	case 3:
		query += expr + " = true"
	case 4:
		query += "IS_NULL(" + expr + ")"
	case 5:
		query = "SELECT TOP 1 1 AS found FROM c WHERE NOT IS_DEFINED(" + expr + ") OR IS_OBJECT(" + expr + ") OR IS_ARRAY(" + expr + ")"
	}
	h := http.Header{}
	h.Set("x-ms-documentdb-partitionkeyrangeid", cur.Ranges[cur.Range])
	h.Set("x-ms-documentdb-isquery", "true")
	h.Set("x-ms-documentdb-query-iscontinuationexpected", "true")
	h.Set("x-ms-max-item-count", "1")
	h.Set("Content-Type", "application/query+json")
	if cur.Token != "" {
		h.Set("x-ms-continuation", cur.Token)
	}
	body, _ := json.Marshal(map[string]any{"query": query, "parameters": parameters})
	p, err := c.request("POST", "docs", link, parent+"/docs", body, h, "")
	if err != nil {
		return result, err
	}
	result.RU += p.RU
	p, err = unwrap(p, "Documents")
	if err != nil {
		return result, err
	}
	var docs []json.RawMessage
	if json.Unmarshal(p.Items, &docs) != nil || len(docs) > 1 {
		return result, errors.New("Invalid TOP 1 seek result")
	}
	result.Scanned = len(docs)
	cur.Token = p.Continuation
	if len(docs) == 1 {
		key := "[{}]"
		if cur.Phase != 5 {
			key, err = partitionKeyFor(docs[0], []string{"/k0"})
		}
		if err != nil {
			return result, err
		}
		result.Keys = append(result.Keys, key)
		cur.Token = "" // Start a new strict boundary query, never reuse the old query token.
		if cur.Phase < 2 {
			var row map[string]json.RawMessage
			_ = json.Unmarshal(docs[0], &row)
			next := row["k0"]
			if (cur.Phase == 0 && !isJSONString(next)) || (cur.Phase == 1 && !isJSONNumber(next)) || !seekAdvanced(cur.After, next, cur.Phase) {
				return result, errors.New("Index seek did not return a new value; refresh the partition list")
			}
			cur.After = next
		} else {
			cur.Phase++
		}
	} else if cur.Token == "" {
		cur.Phase++
		cur.After = nil
	}
	if cur.Phase > 5 {
		cur.Range++
		cur.Phase = 0
		cur.After = nil
		cur.Token = ""
	}
	if cur.Range < len(cur.Ranges) {
		data, _ := json.Marshal(cur)
		result.Continuation = base64.RawURLEncoding.EncodeToString(data)
	}
	result.DurationMS = time.Since(start).Milliseconds()
	return result, nil
}

func isJSONString(raw json.RawMessage) bool {
	var s string
	return len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &s) == nil
}
func isJSONNumber(raw json.RawMessage) bool {
	return len(raw) > 0 && (raw[0] == '-' || (raw[0] >= '0' && raw[0] <= '9')) && json.Valid(raw)
}

func seekAdvanced(previous, next json.RawMessage, phase int) bool {
	if len(previous) == 0 {
		return true
	}
	if phase == 0 {
		var a, b string
		if json.Unmarshal(previous, &a) != nil || json.Unmarshal(next, &b) != nil {
			return false
		}
		return b > a
	}
	a, okA := new(big.Rat).SetString(string(previous))
	b, okB := new(big.Rat).SetString(string(next))
	return okA && okB && b.Cmp(a) > 0
}
