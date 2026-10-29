package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
)

// Scoped UI storage is private to a connection endpoint and container. Hashing
// keeps raw account, database and container identifiers out of filenames.
func (c *cosmosClient) scopedDataPath(kind, database, container string, extra ...string) (string, error) {
	root := os.Getenv("DBX_PLUGIN_DATA_DIR")
	if c.cacheRoot != "" {
		root = c.cacheRoot
	}
	if root == "" {
		var err error
		root, err = os.UserConfigDir()
		if err != nil {
			return "", err
		}
		root = filepath.Join(root, "dbx-plugin-cosmosdb")
	}
	identity, _ := json.Marshal(append([]string{c.endpoint, c.cacheID, database, container}, extra...))
	hash := sha256.Sum256(identity)
	return filepath.Join(root, kind, hex.EncodeToString(hash[:])+".json"), nil
}
