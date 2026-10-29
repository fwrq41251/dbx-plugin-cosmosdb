package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

// Local UI input only: never interpreted as a query or exposed to MCP. Keep
// text verbatim, including unfinished syntax and precise parameter numbers.
type queryInput struct {
	SQL              string `json:"sql"`
	PartitionKeyText string `json:"partitionKeyText"`
	ParametersText   string `json:"parametersText"`
	PageSize         int    `json:"pageSize"`
}
type queryInputRecord struct {
	Version int        `json:"version"`
	Input   queryInput `json:"input"`
}

const queryInputLimit = 2 * 1024 * 1024

func (v queryInput) valid() bool {
	return len(v.SQL) <= 256*1024 && len(v.ParametersText) <= 128*1024 && len(v.PartitionKeyText) <= 16*1024 && (v.PageSize == 25 || v.PageSize == 100 || v.PageSize == 250 || v.PageSize == 1000)
}
func defaultQueryInput() queryInput {
	return queryInput{SQL: "SELECT * FROM c", ParametersText: "[]", PageSize: 100}
}
func (p *plugin) queryInputs(c *cosmosClient, database, container string, input *queryInput, workbench ...string) (queryInput, error) {
	p.queryInputMu.Lock()
	defer p.queryInputMu.Unlock()
	value := defaultQueryInput()
	legacyPath, err := c.scopedDataPath("query-input-v1", database, container)
	if err != nil {
		return value, err
	}
	path, primary := legacyPath, true
	if len(workbench) > 0 && workbench[0] != "" {
		p.workbenchMu.Lock()
		record, found, readErr := c.readWorkbench(workbench[0])
		p.workbenchMu.Unlock()
		if readErr != nil {
			return value, readErr
		}
		if !found {
			return value, reasonError("workbench.notOpened", "Workbench must be opened before use")
		}
		primary = !record.NewQuery
		path, err = c.scopedDataPath("query-input-workbench-v1", database, container, workbench[0])
		if err != nil {
			return value, err
		}
	}
	if input == nil {
		if path != legacyPath {
			if _, err := os.Stat(path); os.IsNotExist(err) {
				if primary {
					value, err = readQueryInput(legacyPath)
				}
				if err != nil && !os.IsNotExist(err) {
					return defaultQueryInput(), err
				}
				// Snapshot even a blank input, so another tab can never supply a later
				// restore value for an already initialized workspace/container.
				return writeQueryInput(path, &value)
			}
		}
		return readQueryInput(path)
	}
	value, err = writeQueryInput(path, input)
	if err == nil && primary && path != legacyPath {
		// Preserve the previous close/reopen-connection behavior for the main tab.
		// Explicit New Query workspaces never change this legacy fallback.
		_, err = writeQueryInput(legacyPath, input)
	}
	return value, err
}
func readQueryInput(path string) (queryInput, error) {
	value := defaultQueryInput()
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return value, nil
	}
	if err != nil {
		return value, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, queryInputLimit+1))
	if err != nil {
		return value, err
	}
	var record queryInputRecord
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if len(data) > queryInputLimit || decoder.Decode(&record) != nil || decoder.Decode(new(any)) != io.EOF || record.Version != 1 || !record.Input.valid() {
		return value, reasonError("queryinput.invalidRecord", "Saved query input is invalid")
	}
	return record.Input, nil
}
func writeQueryInput(path string, input *queryInput) (queryInput, error) {
	value := defaultQueryInput()
	if !input.valid() {
		return value, reasonError("queryinput.invalidInput", "Query input exceeds storage limits or has an invalid page size")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return value, err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".query-input-*")
	if err != nil {
		return value, err
	}
	defer os.Remove(file.Name())
	data, _ := json.Marshal(queryInputRecord{Version: 1, Input: *input})
	if len(data) > queryInputLimit {
		file.Close()
		return value, reasonError("queryinput.invalidInput", "Query input exceeds storage limits or has an invalid page size")
	}
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
	if err = os.Rename(file.Name(), path); err != nil {
		return value, err
	}
	return *input, nil
}
