package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

const metadataTTL = 5 * time.Minute

type metadataEntry struct {
	Page    page
	Fetched time.Time
}

func metadataKey(c *cosmosClient) string {
	raw, _ := json.Marshal([]any{c.endpoint, c.cacheID, c.database, c.container, sha256.Sum256(c.key)})
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}

func (p *plugin) containerDefinition(c *cosmosClient, refresh bool) (page, string, time.Time, error) {
	key := metadataKey(c)
	now := time.Now()
	p.mcpMu.Lock()
	cached, ok := p.mcpMetadata[key]
	p.mcpMu.Unlock()
	if !refresh && ok && now.Before(cached.Fetched.Add(metadataTTL)) {
		result := cached.Page
		result.RU = 0
		result.DurationMS = 0
		result.ActivityID = ""
		return result, "cache", cached.Fetched, nil
	}
	result, err := c.containerMetadata(c.database, c.container)
	if err != nil {
		return result, "live", time.Time{}, err
	}
	// Cache only a validated container definition, not a malformed error body.
	var definition struct {
		PartitionKey struct {
			Paths []string `json:"paths"`
		} `json:"partitionKey"`
	}
	if json.Unmarshal([]byte(result.JSON), &definition) == nil && len(definition.PartitionKey.Paths) > 0 && len(result.JSON) <= mcpOutputLimit {
		p.mcpMu.Lock()
		if p.mcpMetadata == nil {
			p.mcpMetadata = make(map[string]metadataEntry)
		}
		for k, v := range p.mcpMetadata {
			if now.After(v.Fetched.Add(metadataTTL)) {
				delete(p.mcpMetadata, k)
			}
		}
		if len(p.mcpMetadata) >= 128 {
			for k := range p.mcpMetadata {
				delete(p.mcpMetadata, k)
				break
			}
		}
		p.mcpMetadata[key] = metadataEntry{Page: result, Fetched: now}
		p.mcpMu.Unlock()
	}
	return result, "live", now, nil
}

func (p *plugin) invalidateDefinition(c *cosmosClient) {
	p.mcpMu.Lock()
	delete(p.mcpMetadata, metadataKey(c))
	p.mcpMu.Unlock()
}
