package main

import (
	"encoding/json"
	"io"
	"math"
	"os"
	"path/filepath"
)

// Contains column names and widths only, never cell contents or credentials.
type tableLayout struct {
	Widths map[string]float64 `json:"widths"`
}

func (c *cosmosClient) layoutPath(database, container string) (string, error) {
	return c.scopedDataPath("table-layout-v1", database, container)
}

func (c *cosmosClient) tablePreferences(database, container string, value *tableLayout) (tableLayout, error) {
	empty := tableLayout{Widths: map[string]float64{}}
	path, err := c.layoutPath(database, container)
	if err != nil {
		return empty, err
	}
	validate := func(v *tableLayout) error {
		if len(v.Widths) > 500 {
			return reasonError("tablelayout.tooManyColumns", "Too many column preferences")
		}
		for name, width := range v.Widths {
			if len(name) > 4096 || math.IsNaN(width) || math.IsInf(width, 0) || width < 80 || width > 800 {
				return reasonError("tablelayout.invalidWidth", "Invalid column width")
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
			return empty, reasonError("tablelayout.invalidPreferences", "Invalid table preferences")
		}
		if err = validate(&empty); err != nil {
			return empty, err
		}
		// Rewrite legacy layouts once, retaining widths but dropping hidden
		// columns and pin toggles. No query or document data is stored here.
		var legacy map[string]json.RawMessage
		if err = json.Unmarshal(data, &legacy); err != nil {
			return empty, err
		}
		if _, hidden := legacy["hidden"]; hidden || legacy["pinId"] != nil {
			f.Close()
			return c.tablePreferences(database, container, &empty)
		}
		return empty, nil
	}
	if err = validate(value); err != nil {
		return empty, err
	}
	data, err := json.Marshal(value)
	if err != nil || len(data) > 128*1024 {
		return empty, reasonError("tablelayout.storageLimit", "Table preferences exceed storage limit")
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
