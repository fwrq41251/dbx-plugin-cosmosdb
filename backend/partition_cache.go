package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type partitionCache struct {
	Version      int      `json:"version"`
	Found        bool     `json:"found"`
	Keys         []string `json:"keys"`
	Continuation string   `json:"continuation"`
	Complete     bool     `json:"complete"`
	UpdatedAt    string   `json:"updatedAt"`
	RU           float64  `json:"ru"`
}

func (c *cosmosClient) partitionCachePath(database, container string) (string, error) {
	root := c.cacheRoot
	if root == "" {
		var err error
		root, err = os.UserCacheDir()
		if err != nil {
			return "", err
		}
	}
	identity, _ := json.Marshal([]string{c.endpoint, c.cacheID, database, container})
	hash := sha256.Sum256(identity)
	return filepath.Join(root, "dbx-plugin-cosmosdb", "partition-keys-v1", hex.EncodeToString(hash[:])+".json"), nil
}

func (c *cosmosClient) readPartitionCache(database, container string) (partitionCache, error) {
	empty := partitionCache{Version: 1, Keys: []string{}}
	path, err := c.partitionCachePath(database, container)
	if err != nil {
		return empty, err
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return empty, nil
	}
	if err != nil {
		return empty, err
	}
	defer f.Close()
	const limit = 8 * 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || len(data) > limit {
		return empty, errors.New("Invalid partition cache size")
	}
	var cache partitionCache
	if json.Unmarshal(data, &cache) != nil || cache.Version != 1 || len(cache.Keys) > 20000 || len(cache.Continuation) > 128*1024 || cache.Complete != (cache.Continuation == "") {
		return empty, errors.New("Invalid partition cache")
	}
	for _, key := range cache.Keys {
		if _, err := partitionHeader(json.RawMessage(key)); err != nil {
			return empty, errors.New("Invalid cached partition key")
		}
	}
	if _, err := time.Parse(time.RFC3339, cache.UpdatedAt); err != nil {
		return empty, errors.New("Invalid partition cache timestamp")
	}
	cache.Found = true
	return cache, nil
}

// Persist only keys/cursor, never credentials or document bodies. Atomic private
// files let a restarted workbench reuse the snapshot without an Azure request.
func (c *cosmosClient) savePartitionCache(r request, p keyPage) error {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	cache := partitionCache{Version: 1, Keys: []string{}}
	if r.Continuation != "" {
		var err error
		cache, err = c.readPartitionCache(r.Database, r.Container)
		if err != nil {
			return err
		}
		if !cache.Found || cache.Continuation != r.Continuation {
			return errors.New("Partition cache cursor changed; refresh the list")
		}
	}
	keys := map[string]bool{}
	for _, key := range append(cache.Keys, p.Keys...) {
		keys[key] = true
	}
	if len(keys) > 20000 {
		return errors.New("Partition cache exceeds 20000 keys")
	}
	cache.Keys = make([]string, 0, len(keys))
	for key := range keys {
		cache.Keys = append(cache.Keys, key)
	}
	sort.Strings(cache.Keys)
	cache.Continuation = p.Continuation
	cache.Complete = p.Continuation == ""
	cache.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	cache.RU += p.RU
	path, err := c.partitionCachePath(r.Database, r.Container)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".partition-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = json.NewEncoder(f).Encode(cache); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
