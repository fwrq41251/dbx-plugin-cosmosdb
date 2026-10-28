package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
)

// Contains column names and widths only, never cell contents or credentials.
type tableLayout struct {
	Hidden []string           `json:"hidden"`
	Widths map[string]float64 `json:"widths"`
	PinID  *bool              `json:"pinId,omitempty"`
}

func (c *cosmosClient) layoutPath(database, container string) (string, error) {
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
	identity, _ := json.Marshal([]string{c.endpoint, c.cacheID, database, container})
	hash := sha256.Sum256(identity)
	return filepath.Join(root, "table-layout-v1", hex.EncodeToString(hash[:])+".json"), nil
}
func (c *cosmosClient) tablePreferences(database, container string, value *tableLayout) (tableLayout, error) {
	empty := tableLayout{Hidden: []string{}, Widths: map[string]float64{}}
	path, err := c.layoutPath(database, container)
	if err != nil {
		return empty, err
	}
	validate := func(v *tableLayout) error {
		if len(v.Hidden) > 500 || len(v.Widths) > 500 {
			return errors.New("Too many column preferences")
		}
		for _, name := range v.Hidden {
			if len(name) > 4096 {
				return errors.New("Column name is too long")
			}
		}
		for name, width := range v.Widths {
			if len(name) > 4096 || math.IsNaN(width) || math.IsInf(width, 0) || width < 80 || width > 800 {
				return errors.New("Invalid column width")
			}
		}
		return nil
	}
	if value == nil {
		f, err := os.Open(path)
		if os.IsNotExist(err) {
			return empty, nil
		}
		if err != nil {
			return empty, err
		}
		defer f.Close()
		data, err := io.ReadAll(io.LimitReader(f, 128*1024+1))
		if err != nil {
			return empty, err
		}
		if len(data) > 128*1024 || json.Unmarshal(data, &empty) != nil {
			return empty, errors.New("Invalid table preferences")
		}
		return empty, validate(&empty)
	}
	if err = validate(value); err != nil {
		return empty, err
	}
	data, err := json.Marshal(value)
	if err != nil || len(data) > 128*1024 {
		return empty, errors.New("Table preferences exceed storage limit")
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return empty, err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".layout-*")
	if err != nil {
		return empty, err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return empty, err
	}
	if err = f.Close(); err != nil {
		return empty, err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return empty, err
	}
	return *value, nil
}
