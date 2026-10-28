package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestTableLayoutPersistsByConnectionAndContainerWithoutDocumentData(t *testing.T) {
	c := &cosmosClient{endpoint: "https://example.documents.azure.com", cacheID: "one", cacheRoot: t.TempDir()}
	layout := &tableLayout{Widths: map[string]float64{"id": 200}}
	if _, err := c.tablePreferences("Shop", "Orders", layout); err != nil {
		t.Fatal(err)
	}
	c2 := &cosmosClient{endpoint: c.endpoint, cacheID: c.cacheID, cacheRoot: c.cacheRoot}
	saved, err := c2.tablePreferences("Shop", "Orders", nil)
	if err != nil || saved.Widths["id"] != 200 {
		t.Fatal(saved, err)
	}
	other, err := c2.tablePreferences("Shop", "Archive", nil)
	if err != nil || len(other.Widths) != 0 {
		t.Fatal(other, err)
	}
	c2.cacheID = "two"
	other, err = c2.tablePreferences("Shop", "Orders", nil)
	if err != nil || len(other.Widths) != 0 {
		t.Fatal(other, err)
	}
	path, _ := c.layoutPath("Shop", "Orders")
	stat, _ := os.Stat(path)
	if stat.Mode().Perm() != 0600 {
		t.Fatal(stat.Mode())
	}
	invalid := &tableLayout{Widths: map[string]float64{"id": 9999}}
	if _, err = c.tablePreferences("Shop", "Orders", invalid); err == nil {
		t.Fatal("invalid width accepted")
	}
	saved, err = c.tablePreferences("Shop", "Orders", nil)
	if err != nil || saved.Widths["id"] != 200 {
		t.Fatal("invalid update corrupted saved preferences")
	}
}

func TestLegacyTableLayoutDropsHiddenAndPinWithoutLosingWidths(t *testing.T) {
	c := &cosmosClient{endpoint: "https://example.documents.azure.com", cacheID: "legacy", cacheRoot: t.TempDir()}
	if _, err := c.tablePreferences("Shop", "Orders", &tableLayout{Widths: map[string]float64{}}); err != nil {
		t.Fatal(err)
	}
	path, _ := c.layoutPath("Shop", "Orders")
	if err := os.WriteFile(path, []byte(`{"hidden":["status","id"],"pinId":false,"widths":{"id":240,"status":180}}`), 0600); err != nil {
		t.Fatal(err)
	}
	saved, err := c.tablePreferences("Shop", "Orders", nil)
	if err != nil || saved.Widths["id"] != 240 || saved.Widths["status"] != 180 {
		t.Fatal(saved, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	if _, exists := fields["hidden"]; exists {
		t.Fatal("legacy hidden columns were retained")
	}
	if _, exists := fields["pinId"]; exists {
		t.Fatal("legacy pin setting was retained")
	}
	again, err := c.tablePreferences("Shop", "Orders", nil)
	if err != nil || again.Widths["id"] != 240 {
		t.Fatal(again, err)
	}
}
