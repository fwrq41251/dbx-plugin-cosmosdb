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
	mu          sync.RWMutex
	connections map[string]*cosmosClient
	mcpMu       sync.Mutex
	mcpCursors  map[string]mcpCursor
	queriesMu   sync.Mutex
	queries     map[string]*queryJob
	mcpMetadata map[string]metadataEntry
}
type request struct {
	ConnectionID string          `json:"connectionId"`
	QueryID      string          `json:"queryId"`
	Context      context.Context `json:"-"`
	Preferences  *tableLayout    `json:"preferences"`
	Connection   connection      `json:"connection"`
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
		return nil, sdk.NewError(-32602, "Invalid request parameters")
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
			return nil, sdk.NewError(-32602, "Missing connection id")
		}
		if len(r.Runtime.Proxy) > 0 && string(r.Runtime.Proxy) != "null" {
			return nil, sdk.NewError(-32602, "Proxy and SSH routes are not supported in this version")
		}
		if r.Runtime.Host != "" && r.Runtime.Host != r.Connection.Host {
			return nil, sdk.NewError(-32602, "SSH forwarding is not supported in this version")
		}
		if r.Runtime.Port != 0 && r.Connection.Port != 0 && r.Runtime.Port != r.Connection.Port {
			return nil, sdk.NewError(-32602, "Port forwarding is not supported in this version")
		}
		readOnly := true
		if r.Connection.Config.ReadOnly != nil {
			readOnly = *r.Connection.Config.ReadOnly
		}
		c, err := newClient(r.Connection.Host, r.Connection.Secrets["account_key"], readOnly || r.Connection.ReadOnly)
		if err != nil {
			return nil, sdk.NewError(-32602, err.Error())
		}
		c.database, c.container = r.Connection.Config.Database, r.Connection.Config.Container
		c.cacheID = r.Connection.ID
		if (c.database == "") != (c.container == "") {
			return nil, sdk.NewError(-32602, "Database ID and Container ID must be configured together")
		}
		if c.database != "" {
			if err = validID(c.database); err == nil {
				err = validID(c.container)
			}
			if err == nil {
				_, err = c.containerMetadata(c.database, c.container)
			}
		} else {
			_, err = c.list("dbs", "", "", "Databases", "", 1)
		}
		if err != nil {
			return nil, rpcError(err)
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
		return nil, sdk.NewError(-32010, "Connection is not active. Reopen the saved Cosmos DB connection.")
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
		return map[string]any{"readOnly": c.readOnly, "database": c.database, "container": c.container}, nil
	}
	if c.database != "" && ((r.Database != "" && r.Database != c.database) || (r.Container != "" && r.Container != c.container)) {
		return nil, sdk.NewError(-32602, "This connection is scoped to its saved database and container")
	}
	if r.PageSize == 0 {
		r.PageSize = 100
	}
	if r.PageSize < 1 || r.PageSize > 1000 {
		return nil, sdk.NewError(-32602, "Page size must be between 1 and 1000")
	}
	var result any
	var err error
	switch method {
	case "cosmos/tablePreferences":
		if validID(r.Database) != nil || validID(r.Container) != nil {
			err = errors.New("A database and container are required")
		} else {
			result, err = c.tablePreferences(r.Database, r.Container, r.Preferences)
		}
	case "cosmos/databases":
		if c.database != "" {
			items, _ := json.Marshal([]map[string]string{{"id": c.database}})
			result = page{JSON: string(items)}
		} else {
			result, err = c.list("dbs", "", "", "Databases", r.Continuation, r.PageSize)
		}
	case "cosmos/containers":
		if err = validID(r.Database); err == nil {
			if c.container != "" {
				var metadata page
				metadata, err = c.containerMetadata(c.database, c.container)
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
				return nil, sdk.NewError(-32602, "Parameters must be a JSON array")
			}
		}
		if r.OperationsText != "" {
			if json.Unmarshal([]byte(r.OperationsText), &r.Operations) != nil {
				return nil, sdk.NewError(-32602, "局部更新操作必须是 JSON 数组")
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
	if errors.Is(err, context.Canceled) {
		return sdk.NewError(-32800, "查询已取消；已产生的 RU 不会退回，未收到响应的消耗未知")
	}
	if e, ok := err.(*serviceError); ok {
		return &sdk.PluginError{Code: -32000, Message: e.Error(), Data: map[string]any{"status": e.status, "activityId": e.activityID, "retryAfterMs": e.retryAfter, "category": e.category, "serviceCode": e.errorCode, "position": e.position}}
	}
	return sdk.NewError(-32602, err.Error())
}
func main() {
	if err := sdk.NewServer(sdk.Metadata{ID: pluginID, Version: "0.10.0", Capabilities: []string{"connections"}}, &plugin{connections: make(map[string]*cosmosClient)}).Serve(); err != nil {
		log.Fatal(err)
	}
}
