package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// Plugin-wide visual preferences only. Never store query or document content.
type viewPreferences struct {
	Version  int    `json:"version"`
	Results  string `json:"results"`
	Document string `json:"document"`
}
type viewPreferencePatch struct {
	Results  *string `json:"results"`
	Document *string `json:"document"`
}

func defaultViewPreferences() viewPreferences { return viewPreferences{1, "table", "fields"} }
func (v viewPreferences) valid() bool {
	return v.Version == 1 && (v.Results == "table" || v.Results == "json") && (v.Document == "fields" || v.Document == "json")
}
func (c *cosmosClient) viewPreferencesPath() (string, error) {
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
	return filepath.Join(root, "view-preferences-v1.json"), nil
}
func (p *plugin) viewPreferences(c *cosmosClient, patch *viewPreferencePatch) (viewPreferences, error) {
	p.viewMu.Lock()
	defer p.viewMu.Unlock()
	value := defaultViewPreferences()
	if patch != nil {
		proposed := value
		if patch.Results != nil {
			proposed.Results = *patch.Results
		}
		if patch.Document != nil {
			proposed.Document = *patch.Document
		}
		if !proposed.valid() {
			return value, errors.New("Invalid view preference")
		}
	}
	path, err := c.viewPreferencesPath()
	if err != nil {
		return value, err
	}
	f, err := os.Open(path)
	if err == nil {
		data, readErr := io.ReadAll(io.LimitReader(f, 4097))
		f.Close()
		if readErr != nil {
			return value, readErr
		}
		var saved viewPreferences
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if len(data) <= 4096 && decoder.Decode(&saved) == nil && decoder.Decode(new(any)) == io.EOF && saved.valid() {
			value = saved
		}
	} else if !os.IsNotExist(err) {
		return value, err
	}
	// Corrupt/obsolete preferences fall back to defaults and can be repaired by a new choice.
	if patch == nil {
		return value, nil
	}
	if patch.Results != nil {
		value.Results = *patch.Results
	}
	if patch.Document != nil {
		value.Document = *patch.Document
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return value, err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".views-*")
	if err != nil {
		return value, err
	}
	defer os.Remove(file.Name())
	data, _ := json.Marshal(value)
	if _, err = file.Write(data); err != nil {
		file.Close()
		return value, err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return value, err
	}
	if err = file.Close(); err != nil {
		return value, err
	}
	return value, os.Rename(file.Name(), path)
}
