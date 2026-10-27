package main

import (
	"os"
	"strings"
	"testing"
)

func TestPartitionCachePersistsAcrossClientsAndScopes(t *testing.T) {
	c, err := newClient("https://example.com", testKey, true)
	if err != nil {
		t.Fatal(err)
	}
	c.cacheRoot = t.TempDir()
	c.cacheID = "connection-a"
	r := request{Database: "db", Container: "items"}
	if err = c.savePartitionCache(r, keyPage{Keys: []string{`["alpha"]`, `[9223372036854775807]`}, Continuation: "resume", RU: 3}); err != nil {
		t.Fatal(err)
	}
	copy, _ := newClient(c.endpoint, testKey, true)
	copy.cacheRoot = c.cacheRoot
	copy.cacheID = c.cacheID
	cached, err := copy.readPartitionCache("db", "items")
	if err != nil || !cached.Found || cached.Complete || len(cached.Keys) != 2 || cached.Continuation != "resume" {
		t.Fatalf("%+v %v", cached, err)
	}
	r.Continuation = "resume"
	if err = copy.savePartitionCache(r, keyPage{Keys: []string{`["omega"]`}, RU: 4}); err != nil {
		t.Fatal(err)
	}
	cached, err = c.readPartitionCache("db", "items")
	if err != nil || !cached.Complete || len(cached.Keys) != 3 || cached.RU != 7 {
		t.Fatalf("%+v %v", cached, err)
	}
	path, _ := c.partitionCachePath("db", "items")
	info, _ := os.Stat(path)
	if info.Mode().Perm()&0077 != 0 {
		t.Fatal("cache readable by other users")
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), testKey) || strings.Contains(string(data), "example.com") {
		t.Fatal("identity or credential leaked")
	}
	copy.cacheID = "connection-b"
	other, err := copy.readPartitionCache("db", "items")
	if err != nil || other.Found {
		t.Fatal("cache leaked across connections")
	}
	other, err = c.readPartitionCache("db", "other")
	if err != nil || other.Found {
		t.Fatal("cache leaked across containers")
	}
	if err = os.WriteFile(path, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = c.readPartitionCache("db", "items"); err == nil {
		t.Fatal("corrupt cache accepted")
	}
}
