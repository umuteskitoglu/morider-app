package wshub

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// TestDisconnectUserTargetsOnlyThatUser is the regression test for the kick/ban
// hole: removing a participant from the database published a "kick" frame but
// left their socket subscribed, so an ejected rider kept receiving the pack's
// live GPS. DisconnectUser must close exactly their sockets and nobody else's.
func TestDisconnectUserTargetsOnlyThatUser(t *testing.T) {
	h := New(nil, func(int64) string { return "room" }, "")

	victim1 := NewClient(7, 4)
	victim2 := NewClient(7, 4) // same user, second device
	bystander := NewClient(9, 4)
	for _, c := range []*Client{victim1, victim2, bystander} {
		h.Add(1, c)
	}

	h.DisconnectUser(1, 7)

	for i, c := range []*Client{victim1, victim2} {
		select {
		case <-c.Done():
		default:
			t.Fatalf("victim client %d was not disconnected", i)
		}
	}
	select {
	case <-bystander.Done():
		t.Fatal("bystander was disconnected")
	default:
	}
}

func TestDisconnectRoomClosesEveryone(t *testing.T) {
	h := New(nil, func(int64) string { return "room" }, "")
	clients := []*Client{NewClient(1, 4), NewClient(2, 4), NewClient(3, 4)}
	for _, c := range clients {
		h.Add(42, c)
	}

	h.DisconnectRoom(42)

	for i, c := range clients {
		select {
		case <-c.Done():
		default:
			t.Fatalf("client %d still open after DisconnectRoom", i)
		}
	}
}

// TestCloseIsIdempotent guards the close-of-closed-channel panic: the hub, the
// read loop's defer and the shutdown hook can all close the same client.
func TestCloseIsIdempotent(t *testing.T) {
	c := NewClient(1, 1)
	c.Close()
	c.Close()
	c.Close()

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); c.Close() }()
	}
	wg.Wait()
}

// TestTrySendNeverBlocks: a slow client must drop frames rather than stall the
// broadcast for the whole room.
func TestTrySendNeverBlocks(t *testing.T) {
	h := New(nil, func(int64) string { return "room" }, "")
	slow := NewClient(1, 1) // buffer of one, never drained
	h.Add(1, slow)

	// If TrySend blocked, this would deadlock and the test would time out.
	for i := 0; i < 1000; i++ {
		h.BroadcastLocal(1, []byte("position"))
	}

	if got := len(slow.send); got != 1 {
		t.Fatalf("expected the buffer to hold 1 frame and the rest to be dropped, got %d", got)
	}
}

func TestRemoveTearsDownEmptyRoom(t *testing.T) {
	h := New(nil, func(int64) string { return "room" }, "")
	a, b := NewClient(1, 4), NewClient(2, 4)
	h.Add(5, a)
	h.Add(5, b)

	h.Remove(5, a)
	h.mu.Lock()
	_, stillThere := h.subs[5]
	h.mu.Unlock()
	if !stillThere {
		t.Fatal("room dropped while a client was still connected")
	}

	h.Remove(5, b)
	h.mu.Lock()
	_, gone := h.subs[5]
	h.mu.Unlock()
	if gone {
		t.Fatal("room leaked after the last client left")
	}
}

// TestConcurrentAddRemoveBroadcast is a race-detector target: run with -race.
func TestConcurrentAddRemoveBroadcast(t *testing.T) {
	h := New(nil, func(int64) string { return "room" }, "")
	var wg sync.WaitGroup

	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(id int64) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				c := NewClient(id, 2)
				h.Add(id%4, c)
				h.BroadcastLocal(id%4, []byte("x"))
				h.DisconnectUser(id%4, id)
				h.Remove(id%4, c)
				c.Close()
			}
		}(int64(i))
	}
	wg.Wait()
}

func TestCloseAllDisconnectsEveryRoom(t *testing.T) {
	h := New(nil, func(int64) string { return "room" }, "")
	var clients []*Client
	for room := int64(0); room < 5; room++ {
		for i := 0; i < 3; i++ {
			c := NewClient(int64(i), 2)
			clients = append(clients, c)
			h.Add(room, c)
		}
	}

	h.CloseAll()

	for i, c := range clients {
		select {
		case <-c.Done():
		default:
			t.Fatalf("client %d survived CloseAll", i)
		}
	}
}

func TestOriginChecker(t *testing.T) {
	check := OriginChecker([]string{"https://morider.app", "https://www.morider.app"})

	cases := []struct {
		name   string
		origin string
		host   string
		want   bool
	}{
		{"native client sends no origin", "", "api.morider.app", true},
		{"allow-listed origin", "https://morider.app", "api.morider.app", true},
		{"allow-list is case-insensitive", "https://MoRider.app", "api.morider.app", true},
		{"same origin", "https://api.morider.app", "api.morider.app", true},
		{"attacker origin is rejected", "https://evil.example", "api.morider.app", false},
		{"lookalike is rejected", "https://morider.app.evil.example", "api.morider.app", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/ws", nil)
			r.Host = tc.host
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if got := check(r); got != tc.want {
				t.Fatalf("origin %q host %q: got %v, want %v", tc.origin, tc.host, got, tc.want)
			}
		})
	}
}
