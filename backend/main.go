package main

import (
	"context"
	"encoding/json"
	"errors"
	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	"log"
	"strings"
	"sync"
)

const pluginID = "io.github.fwrq41251.cosmosdb"

type plugin struct {
	mu           sync.RWMutex
	connections  map[string]*cosmosClient
	mcpMu        sync.Mutex
	mcpCursors   map[string]mcpCursor
	queriesMu    sync.Mutex
	queries      map[string]*queryJob
	mcpMetadata  map[string]metadataEntry
	viewMu       sync.Mutex
	queryInputMu sync.Mutex
}
type request struct {
	QueryInput   *queryInput          `json:"queryInput"`
	Browse       bool                 `json:"browse"`
	ConnectionID string               `json:"connectionId"`
	QueryID      string               `json:"queryId"`
	Context      context.Context      `json:"-"`
	Preferences  *tableLayout         `json:"preferences"`
	Views        *viewPreferencePatch `json:"views"`
	Connection   connection           `json:"connection"`
	Runtime      struct {
		Host  string          `json:"host"`
		Port  int             `json:"port"`
		Proxy json.RawMessage `json:"proxy"`
	} `json:"runtime"`
	Database         string           `json:"database"`
	Container        string           `json:"container"`
	ID               string           `json:"id"`
	Query            string           `json:"query"`
	Parameters       []parameter      `json:"parameters"`
	Continuation     string           `json:"continuation"`
	PageSize         int              `json:"pageSize"`
	PartitionKey     json.RawMessage  `json:"partitionKey"`
	Document         json.RawMessage  `json:"document"`
	ETag             string           `json:"etag"`
	DocumentText     string           `json:"documentText"`
	PartitionKeyText string           `json:"partitionKeyText"`
	ParametersText   string           `json:"parametersText"`
	DiscoveryMode    string           `json:"discoveryMode"`
	OperationsText   string           `json:"operationsText"`
	Operations       []patchOperation `json:"operations"`
}
type connection struct {
	ID       string            `json:"id"`
	Host     string            `json:"host"`
	Port     int               `json:"port"`
	ReadOnly bool              `json:"read_only"`
	Secrets  map[string]string `json:"connection_secrets"`
	Config   struct {
		ReadOnly  *bool  `json:"read_only"`
		Database  string `json:"database_id"`
		Container string `json:"container_id"`
	} `json:"external_config"`
}

func (p *plugin) Handle(_ sdk.RequestContext, method string, raw json.RawMessage, _ *sdk.Emitter) (any, *sdk.PluginError) {
	if method == "mcp/tools" {
		return mcpTools(), nil
	}
	if method == "mcp/call" {
		return p.mcpCall(raw), nil
	}
	var r request
	if json.Unmarshal(raw, &r) != nil {
		return nil, rpcReason(-32602, "main.invalidParameters", "Invalid request parameters")
	}
	if method == "cosmos/viewPreferences" {
		value, err := p.viewPreferences(&cosmosClient{}, r.Views)
		if err != nil {
			return nil, rpcError(err)
		}
		return value, nil
	}
	if method == "connection/disconnect" {
		p.queriesMu.Lock()
		for key, job := range p.queries {
			if strings.HasPrefix(key, r.Connection.ID+"\x00") && job.cancel != nil {
				job.cancel()
			}
		}
		p.queriesMu.Unlock()
		p.mu.Lock()
		delete(p.connections, r.Connection.ID)
		p.mu.Unlock()
		return map[string]any{"success": true}, nil
	}
	if method == "connection/test" || method == "connection/connect" {
		if r.Connection.ID == "" {
			return nil, rpcReason(-32602, "main.connectionIdRequired", "Missing connection id")
		}
		if len(r.Runtime.Proxy) > 0 && string(r.Runtime.Proxy) != "null" {
			return nil, rpcReason(-32602, "main.unsupportedRoute", "Proxy and SSH routes are not supported in this version")
		}
		if r.Runtime.Host != "" && r.Runtime.Host != r.Connection.Host {
			return nil, rpcReason(-32602, "main.unsupportedSSH", "SSH forwarding is not supported in this version")
		}
		if r.Runtime.Port != 0 && r.Connection.Port != 0 && r.Runtime.Port != r.Connection.Port {
			return nil, rpcReason(-32602, "main.unsupportedPort", "Port forwarding is not supported in this version")
		}
		readOnly := true
		if r.Connection.Config.ReadOnly != nil {
			readOnly = *r.Connection.Config.ReadOnly
		}
		c, err := newClient(r.Connection.Host, r.Connection.Secrets["account_key"], readOnly || r.Connection.ReadOnly)
		if err != nil {
			return nil, rpcError(err)
		}
		c.database, c.container = r.Connection.Config.Database, r.Connection.Config.Container
		c.cacheID = r.Connection.ID
		if (c.database == "") != (c.container == "") {
			return nil, rpcReason(-32602, "main.incompleteScope", "Database ID and Container ID must be configured together")
		}
		if c.database != "" && (validID(c.database) != nil || validID(c.container) != nil) {
			return nil, rpcReason(-32602, "main.invalidLegacyScope", "Invalid legacy database or container")
		}
		location, stored, locationErr := c.selectedScope()
		if locationErr == nil && location.valid() {
			_, err = c.containerMetadata(location.Database, location.Container)
			if err != nil {
				c.unavailableRevision = location.Revision
				_, err = c.list("dbs", "", "", "Databases", "", 1)
			}
		} else {
			_, err = c.list("dbs", "", "", "Databases", "", 1)
		}
		if err != nil {
			return nil, rpcError(err)
		}
		if method == "connection/connect" && locationErr == nil && location.valid() && !stored && c.unavailableRevision == "" {
			if _, err = c.saveSelectedScope(location.Database, location.Container, true); err != nil {
				return nil, rpcError(err)
			}
		}
		if method == "connection/connect" {
			p.mu.Lock()
			p.connections[r.Connection.ID] = c
			p.mu.Unlock()
		}
		return map[string]any{"success": true, "message": "Connected to Azure Cosmos DB for NoSQL", "readOnly": c.readOnly}, nil
	}
	p.mu.RLock()
	c := p.connections[r.ConnectionID]
	p.mu.RUnlock()
	if c == nil {
		return nil, rpcReason(-32010, "main.inactiveConnection", "Connection is not active. Reopen the saved Cosmos DB connection.")
	}
	if method == "cosmos/cancel" {
		return p.cancelQuery(r.ConnectionID, r.QueryID)
	}
	if method == "cosmos/query" && r.QueryID != "" {
		ctx, finish, err := p.beginQuery(r.ConnectionID, r.QueryID)
		if err != nil {
			return nil, rpcError(err)
		}
		defer finish()
		r.Context = ctx
	}
	if method == "cosmos/info" {
		location, _, err := c.selectedScope()
		if err != nil || (location.Revision != "" && location.Revision == c.unavailableRevision) {
			return map[string]any{"readOnly": c.readOnly, "database": "", "container": "", "scopeWarning": "保存的位置不可用，请重新选择数据库和容器", "scopeWarningDetail": reasonDetail{Reason: "warning.scopeUnavailable"}}, nil
		}
		return map[string]any{"readOnly": c.readOnly, "database": location.Database, "container": location.Container}, nil
	}
	if method == "cosmos/selectScope" {
		if validID(r.Database) != nil || validID(r.Container) != nil {
			return nil, rpcReason(-32602, "selectedscope.selectionRequired", "A database and container must be selected together")
		}
		metadata, err := c.containerMetadata(r.Database, r.Container)
		if err != nil {
			return nil, rpcError(err)
		}
		location, err := c.saveSelectedScope(r.Database, r.Container, false)
		if err != nil {
			return nil, rpcReason(-32602, "main.scopeSaveFailed", "位置保存失败，未切换数据库或容器")
		}
		return map[string]any{"database": location.Database, "container": location.Container, "revision": location.Revision, "ru": metadata.RU}, nil
	}
	if r.PageSize == 0 {
		r.PageSize = 100
	}
	if r.PageSize < 1 || r.PageSize > 1000 {
		return nil, rpcReason(-32602, "main.pageSize", "Page size must be between 1 and 1000")
	}
	var result any
	var err error
	switch method {
	case "cosmos/queryInput":
		if validID(r.Database) != nil || validID(r.Container) != nil {
			err = reasonError("main.scopeRequired", "A database and container are required")
		} else {
			result, err = p.queryInputs(c, r.Database, r.Container, r.QueryInput)
		}
	case "cosmos/tablePreferences":
		if validID(r.Database) != nil || validID(r.Container) != nil {
			err = reasonError("main.scopeRequired", "A database and container are required")
		} else {
			result, err = c.tablePreferences(r.Database, r.Container, r.Preferences)
		}
	case "cosmos/databases":
		location, _, scopeErr := c.selectedScope()
		if scopeErr == nil && location.valid() && location.Revision != c.unavailableRevision && !r.Browse {
			items, _ := json.Marshal([]map[string]string{{"id": location.Database}})
			result = page{JSON: string(items)}
		} else {
			result, err = c.list("dbs", "", "", "Databases", r.Continuation, r.PageSize)
		}
	case "cosmos/containers":
		if err = validID(r.Database); err == nil {
			location, _, scopeErr := c.selectedScope()
			if scopeErr == nil && location.valid() && location.Revision != c.unavailableRevision && r.Database == location.Database && !r.Browse {
				var metadata page
				metadata, err = c.containerMetadata(location.Database, location.Container)
				if err == nil {
					metadata.JSON = "[" + string(metadata.Items) + "]"
					result = metadata
				}
			} else {
				result, err = c.list("colls", "dbs/"+r.Database, resourcePath("dbs", r.Database), "DocumentCollections", r.Continuation, r.PageSize)
			}
		}
	case "cosmos/partitionKeys", "cosmos/partitionCache":
		if err = validID(r.Database); err == nil {
			err = validID(r.Container)
		}
		if err == nil {
			if method == "cosmos/partitionCache" {
				result, err = c.readPartitionCache(r.Database, r.Container)
			} else if r.DiscoveryMode == "seek" {
				var keys keyPage
				keys, err = c.seekPartitionKeys(r)
				if err == nil {
					if cacheErr := c.savePartitionCache(r, keys); cacheErr != nil {
						keys.CacheWarning = "本地缓存保存失败，重开后可能需要重新加载。"
						keys.CacheWarningDetail = &reasonDetail{Reason: "warning.cacheSave"}
					}
					result = keys
				}
			} else {
				result, err = c.partitionKeys(r)
			}
		}
	case "cosmos/query", "cosmos/read", "cosmos/create", "cosmos/replace", "cosmos/patch", "cosmos/delete":
		if r.DocumentText != "" {
			r.Document = json.RawMessage(r.DocumentText)
		}
		if r.PartitionKeyText != "" {
			r.PartitionKey = json.RawMessage(r.PartitionKeyText)
		}
		if r.ParametersText != "" {
			if json.Unmarshal([]byte(r.ParametersText), &r.Parameters) != nil {
				return nil, rpcReason(-32602, "main.invalidQueryParameters", "Parameters must be a JSON array")
			}
		}
		if r.OperationsText != "" {
			if json.Unmarshal([]byte(r.OperationsText), &r.Operations) != nil {
				return nil, rpcReason(-32602, "main.invalidPatchOperations", "局部更新操作必须是 JSON 数组")
			}
		}
		if err = validID(r.Database); err == nil {
			err = validID(r.Container)
		}
		if err == nil {
			var document page
			if method == "cosmos/patch" {
				document, err = c.patchDocument(r)
			} else {
				document, err = c.documents(method, r)
			}
			if err == nil && (method == "cosmos/create" || method == "cosmos/replace" || method == "cosmos/patch" || method == "cosmos/delete") {
				ru, cacheErr := c.observeMutation(r, method == "cosmos/delete")
				document.RU += ru
				if cacheErr != nil {
					document.CacheWarning = "文档写入已成功，但分区键缓存更新失败；需要时请刷新列表。"
					document.CacheWarningDetail = &reasonDetail{Reason: "warning.mutationCache"}
				}
			}
			result = document
		}
	default:
		return nil, sdk.MethodNotFound(method)
	}
	if err != nil {
		return nil, rpcError(err)
	}
	return result, nil
}
func rpcError(err error) *sdk.PluginError {
	detail := errorDetail(err)
	if errors.Is(err, context.Canceled) {
		return &sdk.PluginError{Code: -32800, Message: "查询已取消；已产生的 RU 不会退回，未收到响应的消耗未知", Data: detail}
	}
	var e *serviceError
	if errors.As(err, &e) {
		return &sdk.PluginError{Code: -32000, Message: e.Error(), Data: map[string]any{"reason": detail.Reason, "args": detail.Args, "status": e.status, "activityId": e.activityID, "retryAfterMs": e.retryAfter, "category": e.category, "serviceCode": e.errorCode, "position": e.position}}
	}
	return &sdk.PluginError{Code: -32602, Message: err.Error(), Data: detail}
}

func main() {
	if err := sdk.NewServer(sdk.Metadata{ID: pluginID, Version: "0.24.0", Capabilities: []string{"connections"}}, &plugin{connections: make(map[string]*cosmosClient)}).Serve(); err != nil {
		log.Fatal(err)
	}
}
