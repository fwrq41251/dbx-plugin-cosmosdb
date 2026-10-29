package main

import (
	"context"
	"errors"
	sdk "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
)

// Error text remains part of the legacy bridge contract. Reason/args are the
// stable machine-readable contract; args must never contain request data.
type reasonDetail struct {
	Reason string `json:"reason"`
	Args   []any  `json:"args,omitempty"`
}
type detailedError struct {
	detail reasonDetail
	text   string
	cause  error
}

func (e *detailedError) Error() string { return e.text }
func (e *detailedError) Unwrap() error { return e.cause }
func annotateError(reason string, err error) error {
	return &detailedError{detail: reasonDetail{Reason: reason}, text: err.Error(), cause: err}
}
func reasonError(reason, text string) error {
	return &detailedError{detail: reasonDetail{Reason: reason}, text: text}
}
func rpcReason(code int, reason, text string) *sdk.PluginError {
	return &sdk.PluginError{Code: code, Message: text, Data: reasonDetail{Reason: reason}}
}
func errorDetail(err error) reasonDetail {
	var detailed *detailedError
	if errors.As(err, &detailed) {
		return detailed.detail
	}
	if errors.Is(err, context.Canceled) {
		return reasonDetail{Reason: "main.queryCanceled"}
	}
	var service *serviceError
	if errors.As(err, &service) {
		if service.category == "sql-syntax" && service.position >= 0 {
			return reasonDetail{Reason: "cosmos.sql-syntax-position", Args: []any{service.position + 1}}
		}
		if service.category != "" {
			return reasonDetail{Reason: "cosmos." + service.category}
		}
		names := map[int]string{400: "invalid-request", 401: "authentication", 403: "access-denied", 404: "not-found", 409: "conflict", 412: "concurrency", 413: "too-large", 429: "rate-limit", 503: "unavailable"}
		if name := names[service.status]; name != "" {
			return reasonDetail{Reason: "cosmos." + name}
		}
		return reasonDetail{Reason: "cosmos.service"}
	}
	// Foreign filesystem/SDK errors retain their original text, without guessing
	// identity from a rendered message or exposing arguments from that error.
	return reasonDetail{Reason: "internal.failure"}
}
