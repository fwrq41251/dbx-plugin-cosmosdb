package main

import (
	"encoding/json"
	"errors"
	"math/big"
	"reflect"
)

func validateDocumentPartition(document, key, metadata json.RawMessage) error {
	var container struct {
		PartitionKey struct {
			Paths []string `json:"paths"`
		} `json:"partitionKey"`
	}
	if json.Unmarshal(metadata, &container) != nil {
		return errors.New("Invalid container metadata")
	}
	actual, err := partitionKeyFor(document, container.PartitionKey.Paths)
	if err != nil {
		return err
	}
	if !samePartitionKey(json.RawMessage(actual), key) {
		return errors.New("文档正文的分区键与目标分区不一致，请检查分区键字段；更新不能移动文档到其他分区")
	}
	return nil
}
func samePartitionKey(a, b json.RawMessage) bool {
	var left, right []json.RawMessage
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil || len(left) != len(right) {
		return false
	}
	for i, x := range left {
		y := right[i]
		if isJSONNumber(x) && isJSONNumber(y) {
			l, okL := new(big.Rat).SetString(string(x))
			r, okR := new(big.Rat).SetString(string(y))
			if !okL || !okR || l.Cmp(r) != 0 {
				return false
			}
		} else {
			var l, r any
			if json.Unmarshal(x, &l) != nil || json.Unmarshal(y, &r) != nil || !reflect.DeepEqual(l, r) {
				return false
			}
		}
	}
	return true
}

// Update only the touched key. On delete, verify the partition is empty before
// removing its candidate; this is a bounded point-partition query, not a scan.
func (c *cosmosClient) observeMutation(r request, deleted bool) (float64, error) {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	cache, err := c.readPartitionCache(r.Database, r.Container)
	if err != nil {
		return 0, err
	}
	key, err := partitionHeader(r.PartitionKey)
	if err != nil {
		return 0, err
	}
	keys := map[string]bool{}
	for _, value := range cache.Keys {
		keys[value] = true
	}
	ru := 0.0
	if deleted {
		if keys[key] {
			p, queryErr := c.documents("cosmos/query", request{Database: r.Database, Container: r.Container, PartitionKey: r.PartitionKey, Query: "SELECT TOP 1 c.id FROM c", PageSize: 1})
			if queryErr != nil {
				return 0, queryErr
			}
			ru = p.RU
			var docs []json.RawMessage
			if json.Unmarshal(p.Items, &docs) != nil {
				return ru, errors.New("Invalid remaining partition result")
			}
			if len(docs) == 0 && p.Continuation == "" {
				delete(keys, key)
			}
		}
	} else {
		keys[key] = true
	}
	cache.Keys = make([]string, 0, len(keys))
	for key := range keys {
		cache.Keys = append(cache.Keys, key)
	}
	return ru, c.writePartitionCache(r.Database, r.Container, cache)
}
