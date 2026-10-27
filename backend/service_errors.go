package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

func defaultServiceHint(status int) string {
	return map[int]string{
		400: "请求参数不合法。请检查 SQL、分区键或局部更新的路径和值。",
		401: "身份验证失败：请检查 Account Key、账号地址及本机时间。",
		403: "访问被拒绝：请检查凭据权限和 Cosmos DB 的网络访问限制。",
		404: "数据库、容器或文档不存在；文档也可能已被其他人删除。",
		409: "同一分区中已存在此 id，创建未覆盖已有文档。请更换 id 或读取已有文档。",
		412: "并发冲突：文档已变化，本次修改或删除未执行。请重新读取并核对修改。",
		413: "文档或请求过大，请减小文档或当前页大小。",
		429: "请求被限流，本次操作没有自动重试；请等待后再操作。",
		503: "Cosmos DB 暂时不可用；写入结果不确定时请先重新读取，避免重复提交。",
	}[status]
}

var sqlErrorCode = regexp.MustCompile(`^SC\d{4}$`)

// Classify upstream diagnostics but never echo raw messages, SQL literals,
// document values, keys or request headers back through the plugin bridge.
func classifyServiceError(status int, body []byte, substatus string) *serviceError {
	e := &serviceError{status: status, position: -1}
	var envelope struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Errors  []struct {
			Code     string `json:"code"`
			Message  string `json:"message"`
			Location struct {
				Start *int `json:"start"`
			} `json:"location"`
		} `json:"errors"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return e
	}
	for i := 0; i < 2 && strings.HasPrefix(strings.TrimSpace(envelope.Message), "{"); i++ {
		var nested = json.RawMessage(envelope.Message)
		var next = envelope
		if json.Unmarshal(nested, &next) != nil {
			break
		}
		envelope = next
	}
	m := strings.ToLower(envelope.Message)
	for _, item := range envelope.Errors {
		m += " " + strings.ToLower(item.Message)
		if sqlErrorCode.MatchString(item.Code) {
			e.errorCode = item.Code
			if item.Location.Start != nil && *item.Location.Start >= 0 && *item.Location.Start < 500000 {
				e.position = *item.Location.Start
			}
		}
	}
	if status == 400 {
		switch {
		case strings.Contains(m, "syntax error") || strings.Contains(m, "parse error"):
			e.category = "sql-syntax"
			e.hint = "SQL 语法错误：检查 WHERE、AND、括号和引号。"
			if e.position >= 0 {
				e.hint = fmt.Sprintf("SQL 语法错误：第 %d 个字符附近。检查 WHERE、AND、括号和引号。", e.position+1)
			}
		case substatus == "1001" || (strings.Contains(m, "partition key") && (strings.Contains(m, "mismatch") || strings.Contains(m, "not match") || strings.Contains(m, "extracted") || strings.Contains(m, "invalid") || strings.Contains(m, "components"))):
			e.category = "partition-key"
			e.hint = "分区键不匹配：请核对分区键路径、组件数量及字符串/数字类型，正文分区字段必须与目标分区一致。"
		case strings.Contains(m, "query plan") || strings.Contains(m, "client pipeline") || strings.Contains(m, "query execution context") || strings.Contains(m, "cross partition query can not be directly served"):
			e.category = "query-pipeline"
			e.hint = "此查询需要 SDK 跨分区查询管线，当前插件尚不支持；请指定分区键或简化查询。"
		case strings.Contains(m, "index path") || strings.Contains(m, "composite index") || strings.Contains(m, "corresponding index"):
			e.category = "index"
			e.hint = "查询所需索引不可用：请检查排序字段的索引或复合索引。"
		case strings.Contains(m, "patch"):
			e.category = "patch"
			e.hint = "局部更新失败：检查字段路径是否存在、父字段类型、值格式，以及操作数是否超过 10。"
		}
	}
	if status == 403 {
		if strings.Contains(m, "read only") || strings.Contains(m, "read-only") || strings.Contains(m, "readonly") {
			e.category = "write-permission"
			e.hint = "当前凭据没有写入权限：请使用可写 Account Key。关闭连接的只读开关不会改变 Key 的权限。"
		} else if strings.Contains(m, "firewall") || strings.Contains(m, "ip address") || strings.Contains(m, "virtual network") {
			e.category = "network-access"
			e.hint = "网络访问被拒绝：请检查 Cosmos DB 防火墙、允许的 IP 或虚拟网络设置。"
		}
	}
	if status == 412 {
		e.category = "concurrency"
	}
	return e
}
