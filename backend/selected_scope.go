package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// Position only: no credentials, SQL, parameters or document data.
type selectedScope struct {
	Version   int    `json:"version"`
	Database  string `json:"database"`
	Container string `json:"container"`
	Revision  string `json:"revision"`
}

func (c *cosmosClient) selectedScopePath() (string, error) {
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
	identity, _ := json.Marshal([]string{c.endpoint, c.cacheID})
	hash := sha256.Sum256(identity)
	return filepath.Join(root, "selected-scope-v1", hex.EncodeToString(hash[:])+".json"), nil
}
func (s selectedScope) valid() bool {
	return s.Version == 1 && validID(s.Database) == nil && validID(s.Container) == nil && s.Revision != "" && len(s.Revision) <= 128
}
func (c *cosmosClient) selectedScope() (selectedScope, bool, error) {
	path, err := c.selectedScopePath()
	if err != nil {
		return selectedScope{}, false, err
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		if c.database == "" && c.container == "" {
			return selectedScope{}, false, nil
		}
		legacy := selectedScope{1, c.database, c.container, "legacy"}
		if !legacy.valid() {
			return selectedScope{}, false, reasonError("selectedscope.invalidLegacyPosition", "Invalid legacy container position")
		}
		return legacy, false, nil
	}
	if err != nil {
		return selectedScope{}, false, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 8193))
	var location selectedScope
	if err != nil || len(data) > 8192 || json.Unmarshal(data, &location) != nil || !location.valid() {
		return selectedScope{}, false, reasonError("selectedscope.invalidSavedPosition", "Saved container position is invalid; select a container in the workbench")
	}
	return location, true, nil
}
func (c *cosmosClient) saveSelectedScope(database, container string, migrate bool) (selectedScope, error) {
	location := selectedScope{Version: 1, Database: database, Container: container}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return location, err
	}
	location.Revision = hex.EncodeToString(nonce)
	if !location.valid() {
		return location, reasonError("selectedscope.selectionRequired", "A database and container must be selected together")
	}
	path, err := c.selectedScopePath()
	if err != nil {
		return location, err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return location, err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".scope-*")
	if err != nil {
		return location, err
	}
	defer os.Remove(f.Name())
	data, _ := json.Marshal(location)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return location, err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return location, err
	}
	if err = f.Close(); err != nil {
		return location, err
	}
	if migrate {
		// Publish an initial legacy value only if no user selection has won already.
		err = os.Link(f.Name(), path)
		if os.IsExist(err) {
			current, _, readErr := c.selectedScope()
			return current, readErr
		}
	} else {
		err = os.Rename(f.Name(), path)
	}
	return location, err
}
