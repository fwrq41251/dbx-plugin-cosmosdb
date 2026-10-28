package main

import (
	"os"
	"testing"
)

func TestTableLayoutPersistsByConnectionAndContainerWithoutDocumentData(t *testing.T) {
	c := &cosmosClient{endpoint: "https://example.documents.azure.com", cacheID: "one", cacheRoot: t.TempDir()}
	pin := true
	layout := &tableLayout{Hidden: []string{"private-field"}, Widths: map[string]float64{"id": 200}, PinID: &pin}
	if _, err := c.tablePreferences("Shop", "Orders", layout); err != nil {
		t.Fatal(err)
	}
	c2 := &cosmosClient{endpoint: c.endpoint, cacheID: c.cacheID, cacheRoot: c.cacheRoot}
	saved, err := c2.tablePreferences("Shop", "Orders", nil)
	if err != nil || saved.Widths["id"] != 200 || len(saved.Hidden) != 1 {
		t.Fatal(saved, err)
	}
	other, err := c2.tablePreferences("Shop", "Archive", nil)
	if err != nil || len(other.Hidden) != 0 {
		t.Fatal(other, err)
	}
	c2.cacheID = "two"
	other, err = c2.tablePreferences("Shop", "Orders", nil)
	if err != nil || len(other.Hidden) != 0 {
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
