package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// TestHijackedRequestContextStaysLive pins down the behaviour that
// ContextWithFallback = true depends on.
//
// With the fallback enabled, gin.Context delegates Done()/Err() to the HTTP
// request context. Handlers pass the gin.Context straight to pgx, including
// inside WebSocket read loops that live for the whole ride. If hijacking the
// connection cancelled the request context, every query issued after the
// upgrade would fail instantly — turning a latency fix into an outage.
//
// This test asserts the context is still live after the upgrade and stays live
// while the socket is in use.
func TestHijackedRequestContextStaysLive(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.ContextWithFallback = true

	type result struct {
		afterUpgrade error
		afterRead    error
	}
	results := make(chan result, 1)

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	engine.GET("/ws", func(c *gin.Context) {
		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()

		var r result
		r.afterUpgrade = c.Err()

		if _, _, err := conn.ReadMessage(); err != nil {
			t.Errorf("read: %v", err)
			return
		}
		r.afterRead = c.Err()
		results <- r
	})

	srv := httptest.NewServer(engine)
	defer srv.Close()

	conn, _, err := websocket.DefaultDialer.Dial(strings.Replace(srv.URL, "http", "ws", 1)+"/ws", nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case r := <-results:
		if r.afterUpgrade != nil {
			t.Fatalf("request context was already cancelled right after Upgrade: %v — "+
				"every DB query in a WebSocket read loop would fail", r.afterUpgrade)
		}
		if r.afterRead != nil {
			t.Fatalf("request context cancelled while the socket was still in use: %v", r.afterRead)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not report back")
	}
}

// TestContextFallbackCancelsOnClientDisconnect is the other half: for ordinary
// requests the fallback must actually propagate cancellation, otherwise pgx
// keeps running queries for clients that hung up and the pool drains.
func TestContextFallbackCancelsOnClientDisconnect(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.ContextWithFallback = true

	cancelled := make(chan error, 1)
	engine.GET("/slow", func(c *gin.Context) {
		select {
		case <-c.Done():
			cancelled <- c.Err()
		case <-time.After(5 * time.Second):
			cancelled <- nil
		}
	})

	srv := httptest.NewServer(engine)
	defer srv.Close()

	client := &http.Client{Timeout: 200 * time.Millisecond}
	_, _ = client.Get(srv.URL + "/slow") // deliberately times out client-side

	select {
	case err := <-cancelled:
		if err == nil {
			t.Fatal("handler was not cancelled when the client disconnected; " +
				"abandoned queries would keep holding pool connections")
		}
	case <-time.After(6 * time.Second):
		t.Fatal("handler never returned")
	}
}
