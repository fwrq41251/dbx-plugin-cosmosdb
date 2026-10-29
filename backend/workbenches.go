package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// Only location and creation mode, never results, documents or credentials.
// Workbench ids come from DBX's persisted native-tab context.
type workbenchRecord struct {
	Version   int    `json:"version"`
	Database  string `json:"database"`
	Container string `json:"container"`
	NewQuery  bool   `json:"newQuery"`
}

func validWorkbenchID(id string) bool {
	if len(id) > 128 {
		return false
	}
	for _, ch := range id {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			return false
		}
	}
	return true
}
func (c *cosmosClient) readWorkbench(id string) (workbenchRecord, bool, error) {
	var record workbenchRecord
	if id == "" || !validWorkbenchID(id) {
		return record, false, reasonError("workbench.invalidId", "Invalid workbench id")
	}
	path, err := c.scopedDataPath("workbenches-v1", "", "", id)
	if err != nil {
		return record, false, err
	}
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return record, false, nil
	}
	if err != nil {
		return record, false, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 8193))
	if err != nil {
		return record, false, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if len(data) > 8192 || decoder.Decode(&record) != nil || decoder.Decode(new(any)) != io.EOF || record.Version != 1 || ((record.Database != "" || record.Container != "") && (validID(record.Database) != nil || validID(record.Container) != nil)) {
		return record, false, reasonError("workbench.invalidRecord", "Invalid saved workbench position")
	}
	return record, true, nil
}
func (c *cosmosClient) writeWorkbench(id string, record workbenchRecord) error {
	path, err := c.scopedDataPath("workbenches-v1", "", "", id)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".workbench-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	data, err := json.Marshal(record)
	if err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}
func (r workbenchRecord) scope() selectedScope {
	// A local position is deliberately independent of the connection's MCP
	// revision: another tab changing the default must not invalidate this view.
	return selectedScope{Version: 1, Database: r.Database, Container: r.Container, Revision: "workbench"}
}
func (p *plugin) openWorkbench(c *cosmosClient, id, source string, fresh bool) (selectedScope, error) {
	if id == "" {
		location, _, err := c.selectedScope()
		return location, err
	}
	if !validWorkbenchID(id) || !validWorkbenchID(source) {
		return selectedScope{}, reasonError("workbench.invalidId", "Invalid workbench id")
	}
	p.workbenchMu.Lock()
	defer p.workbenchMu.Unlock()
	record, found, err := c.readWorkbench(id)
	if err != nil {
		return selectedScope{}, err
	}
	if found {
		return record.scope(), nil
	}
	location, _, err := c.selectedScope()
	if fresh && source != "" {
		original, exists, sourceErr := c.readWorkbench(source)
		if sourceErr != nil {
			return selectedScope{}, sourceErr
		}
		if exists {
			location, err = original.scope(), nil
		}
	}
	locationErr := err
	if err != nil {
		location = selectedScope{}
	}
	record = workbenchRecord{Version: 1, Database: location.Database, Container: location.Container, NewQuery: fresh}
	if err := c.writeWorkbench(id, record); err != nil {
		return selectedScope{}, err
	}
	return record.scope(), locationErr
}
func (p *plugin) workbenchScope(c *cosmosClient, id string) (selectedScope, error) {
	if id == "" {
		location, _, err := c.selectedScope()
		return location, err
	}
	p.workbenchMu.Lock()
	defer p.workbenchMu.Unlock()
	record, found, err := c.readWorkbench(id)
	if err == nil && !found {
		err = reasonError("workbench.notOpened", "Workbench must be opened before use")
	}
	return record.scope(), err
}
func (p *plugin) saveWorkbenchScope(c *cosmosClient, id string, location selectedScope) error {
	if id == "" {
		return nil
	}
	p.workbenchMu.Lock()
	defer p.workbenchMu.Unlock()
	record, found, err := c.readWorkbench(id)
	if err != nil {
		return err
	}
	if !found {
		return reasonError("workbench.notOpened", "Workbench must be opened before use")
	}
	record.Database, record.Container = location.Database, location.Container
	return c.writeWorkbench(id, record)
}
