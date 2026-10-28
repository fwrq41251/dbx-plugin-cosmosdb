package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type cosmosClient struct {
	endpoint  string
	key       []byte
	http      *http.Client
	readOnly  bool
	database  string
	container string
	cacheID   string
	cacheRoot string // Empty uses the operating system's user cache directory.
	cacheMu   sync.Mutex
	mu        sync.Mutex
	sessions  map[string]string
}
type parameter struct {
	Name  string          `json:"name"`
	Value json.RawMessage `json:"value"`
}
type page struct {
	Items        json.RawMessage `json:"-"`
	JSON         string          `json:"json"`
	Continuation string          `json:"continuation"`
	RU           float64         `json:"ru"`
	DurationMS   int64           `json:"durationMs"`
	ActivityID   string          `json:"activityId"`
	ETag         string          `json:"etag,omitempty"`
	CacheWarning string          `json:"cacheWarning,omitempty"`
}
type serviceError struct {
	status                    int
	activityID, retryAfter    string
	category, hint, errorCode string
	position                  int
}

func (e *serviceError) Error() string {
	message := e.hint
	if message == "" {
		message = defaultServiceHint(e.status)
	}
	if message == "" {
		message = "Cosmos DB request failed."
	}
	return fmt.Sprintf("HTTP %d: %s", e.status, message)
}
func newClient(endpoint, key string, readOnly bool) (*cosmosClient, error) {
	endpoint = strings.TrimSpace(endpoint)
	if !strings.Contains(endpoint, "://") {
		endpoint = "https://" + endpoint
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("Endpoint must be an account URL, for example https://account.documents.azure.com:443/")
	}
	ip := net.ParseIP(u.Hostname())
	local := u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return nil, errors.New("HTTPS is required (HTTP is allowed only for a loopback test service)")
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(key))
	if err != nil || len(decoded) == 0 {
		return nil, errors.New("Account Key must be a non-empty base64 key")
	}
	h := &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &cosmosClient{endpoint: strings.TrimRight(u.String(), "/"), key: decoded, http: h, readOnly: readOnly, sessions: make(map[string]string)}, nil
}
func authorization(key []byte, method, kind, link, date string) string {
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "%s\n%s\n%s\n%s\n\n", strings.ToLower(method), strings.ToLower(kind), link, strings.ToLower(date))
	return url.QueryEscape("type=master&ver=1.0&sig=" + base64.StdEncoding.EncodeToString(mac.Sum(nil)))
}
func validID(id string) error {
	if id == "" || strings.ContainsAny(id, "/\\?#") || strings.HasSuffix(id, " ") {
		return errors.New("Resource id is empty or contains unsupported characters (/ \\ ? # or a trailing space)")
	}
	return nil
}
func resourcePath(parts ...string) string {
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return strings.Join(parts, "/")
}

// A request is one service page. Writes are never automatically retried.
func (c *cosmosClient) request(method, kind, link, path string, body []byte, headers http.Header, sessionKey string) (page, error) {
	return c.requestContext(nil, method, kind, link, path, body, headers, sessionKey)
}
func (c *cosmosClient) requestContext(ctx context.Context, method, kind, link, path string, body []byte, headers http.Header, sessionKey string) (page, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+"/"+path, bytes.NewReader(body))
	if err != nil {
		return page{}, errors.New("Could not construct Cosmos request")
	}
	if headers != nil {
		req.Header = headers.Clone()
	}
	date := time.Now().UTC().Format(http.TimeFormat)
	req.Header.Set("x-ms-date", date)
	req.Header.Set("x-ms-version", "2018-12-31")
	req.Header.Set("Authorization", authorization(c.key, method, kind, link, date))
	req.Header.Set("Accept", "application/json")
	if body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if sessionKey != "" {
		c.mu.Lock()
		token := c.sessions[sessionKey]
		c.mu.Unlock()
		if token != "" {
			req.Header.Set("x-ms-session-token", token)
		}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return page{}, ctx.Err()
		}
		return page{}, errors.New("Cosmos request failed or timed out. Check network access. For a write, its outcome may be unknown; reload before retrying.")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		e := classifyServiceError(resp.StatusCode, data, resp.Header.Get("x-ms-substatus"))
		e.activityID = resp.Header.Get("x-ms-activity-id")
		e.retryAfter = resp.Header.Get("x-ms-retry-after-ms")
		return page{}, e
	}
	const limit = 6 * 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		if ctx.Err() != nil {
			return page{}, ctx.Err()
		}
		return page{}, errors.New("Could not read service response; reload to verify any write outcome")
	}
	if len(data) > limit {
		return page{}, errors.New("Result page exceeds 6 MiB; reduce page size (verify any write outcome before retrying)")
	}
	if len(data) == 0 {
		data = []byte("null")
	}
	if !json.Valid(data) {
		return page{}, errors.New("Service returned invalid JSON")
	}
	if sessionKey != "" {
		if token := resp.Header.Get("x-ms-session-token"); token != "" {
			c.mu.Lock()
			c.sessions[sessionKey] = token
			c.mu.Unlock()
		}
	}
	ru, _ := strconv.ParseFloat(resp.Header.Get("x-ms-request-charge"), 64)
	return page{Items: data, JSON: string(data), Continuation: resp.Header.Get("x-ms-continuation"), RU: ru, DurationMS: time.Since(start).Milliseconds(), ActivityID: resp.Header.Get("x-ms-activity-id"), ETag: resp.Header.Get("ETag")}, nil
}
func (c *cosmosClient) list(kind, link, parent, array, continuation string, size int) (page, error) {
	path := kind
	if parent != "" {
		path = parent + "/" + kind
	}
	h := http.Header{}
	h.Set("x-ms-max-item-count", strconv.Itoa(size))
	if continuation != "" {
		h.Set("x-ms-continuation", continuation)
	}
	p, err := c.request("GET", kind, link, path, nil, h, "")
	if err != nil {
		return p, err
	}
	return unwrap(p, array)
}
func unwrap(p page, key string) (page, error) {
	var o map[string]json.RawMessage
	if json.Unmarshal(p.Items, &o) != nil {
		return p, errors.New("Invalid Cosmos result envelope")
	}
	items, ok := o[key]
	if !ok || len(items) == 0 || items[0] != '[' {
		return p, errors.New("Missing result array in Cosmos response")
	}
	p.Items = items
	p.JSON = string(items)
	return p, nil
}
func partitionHeader(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", nil
	}
	var values []json.RawMessage
	if json.Unmarshal(raw, &values) != nil || len(values) == 0 || len(values) > 3 {
		return "", errors.New("Partition key must be a JSON array with 1–3 components; use [{}] for an undefined value")
	}
	for _, v := range values {
		var x any
		d := json.NewDecoder(bytes.NewReader(v))
		d.UseNumber()
		if d.Decode(&x) != nil {
			return "", errors.New("Invalid partition key")
		}
		switch value := x.(type) {
		case nil, string, bool, json.Number:
		case map[string]any:
			if len(value) != 0 {
				return "", errors.New("Undefined partition key must be {}")
			}
		default:
			return "", errors.New("Partition key components must be scalar values or {}")
		}
	}
	var compact bytes.Buffer
	_ = json.Compact(&compact, raw)
	return compact.String(), nil
}
func (c *cosmosClient) documents(method string, r request) (page, error) {
	link := "dbs/" + r.Database + "/colls/" + r.Container
	path := resourcePath("dbs", r.Database, "colls", r.Container, "docs")
	h := http.Header{}
	pk, err := partitionHeader(r.PartitionKey)
	if err != nil {
		return page{}, err
	}
	if pk != "" {
		h.Set("x-ms-documentdb-partitionkey", pk)
	}
	if method == "cosmos/query" {
		if strings.TrimSpace(r.Query) == "" {
			return page{}, errors.New("Query is required")
		}
		if r.Parameters == nil {
			r.Parameters = []parameter{}
		}
		for _, p := range r.Parameters {
			if !strings.HasPrefix(p.Name, "@") || !json.Valid(p.Value) {
				return page{}, errors.New("Query parameters require @name and a JSON value")
			}
		}
		body, _ := json.Marshal(map[string]any{"query": r.Query, "parameters": r.Parameters})
		h.Set("Content-Type", "application/query+json")
		h.Set("x-ms-documentdb-isquery", "true")
		h.Set("x-ms-documentdb-query-enablecrosspartition", "true")
		h.Set("x-ms-max-item-count", strconv.Itoa(r.PageSize))
		if r.Continuation != "" {
			h.Set("x-ms-continuation", r.Continuation)
		}
		p, err := c.requestContext(r.Context, "POST", "docs", link, path, body, h, link)
		if err != nil {
			return p, err
		}
		return unwrap(p, "Documents")
	}
	if method != "cosmos/read" && c.readOnly {
		return page{}, errors.New("Connection is read-only. Disable Read only in the saved connection to enable document writes")
	}
	if pk == "" {
		return page{}, errors.New("An explicit partition-key array is required for point reads and writes")
	}
	verb := "GET"
	var body []byte
	if method == "cosmos/create" || method == "cosmos/replace" {
		var doc map[string]json.RawMessage
		if json.Unmarshal(r.Document, &doc) != nil || doc == nil {
			return page{}, errors.New("Document must be a JSON object")
		}
		var id string
		if json.Unmarshal(doc["id"], &id) != nil {
			return page{}, errors.New("Document requires a string id")
		}
		if err := validID(id); err != nil {
			return page{}, err
		}
		if method == "cosmos/replace" && id != r.ID {
			return page{}, errors.New("Document id cannot change during replacement")
		}
		for _, f := range []string{"_rid", "_self", "_etag", "_attachments", "_ts"} {
			delete(doc, f)
		}
		body, _ = json.Marshal(doc)
		verb = "POST"
		if method == "cosmos/replace" {
			verb = "PUT"
		}
	}
	if method != "cosmos/create" {
		if err := validID(r.ID); err != nil {
			return page{}, err
		}
		link += "/docs/" + r.ID
		path += "/" + url.PathEscape(r.ID)
	}
	if method == "cosmos/delete" {
		verb = "DELETE"
	}
	if method == "cosmos/replace" || method == "cosmos/delete" {
		if r.ETag == "" || r.ETag == "*" {
			return page{}, errors.New("Reload the complete document first: its ETag is required for update and delete")
		}
		h.Set("If-Match", r.ETag)
	}
	metadataRU := 0.0
	if method == "cosmos/create" || method == "cosmos/replace" {
		meta, metaErr := c.containerMetadata(r.Database, r.Container)
		if metaErr != nil {
			return page{}, metaErr
		}
		if metaErr = validateDocumentPartition(json.RawMessage(body), r.PartitionKey, meta.Items); metaErr != nil {
			return page{}, metaErr
		}
		metadataRU = meta.RU
	}
	p, err := c.request(verb, "docs", link, path, body, h, "dbs/"+r.Database+"/colls/"+r.Container)
	p.RU += metadataRU
	return p, err
}
