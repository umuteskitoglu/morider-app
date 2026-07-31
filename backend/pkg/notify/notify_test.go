package notify

import "testing"

func TestDedupeDropsActorAndRepeats(t *testing.T) {
	got := dedupe([]int64{7, 3, 7, 0, 9, 3}, 9)
	want := []int64{7, 3}
	if len(got) != len(want) {
		t.Fatalf("dedupe() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("dedupe() = %v, want %v (order must be preserved)", got, want)
		}
	}
}

func TestDedupeEmptyWhenOnlyActor(t *testing.T) {
	if got := dedupe([]int64{5, 5}, 5); len(got) != 0 {
		t.Fatalf("dedupe() = %v, want empty: you are never notified about your own action", got)
	}
}

func TestMergeDataCarriesRoutingKeys(t *testing.T) {
	data := mergeData(Event{Kind: KindPostLike, EntityID: 42})
	if data["type"] != string(KindPostLike) {
		t.Fatalf("type = %v, want %q", data["type"], KindPostLike)
	}
	if data["entity_id"] != int64(42) {
		t.Fatalf("entity_id = %v, want 42", data["entity_id"])
	}
}

func TestMergeDataEventDataWins(t *testing.T) {
	data := mergeData(Event{
		Kind:     KindCommunityPost,
		EntityID: 3,
		Data:     map[string]any{"post_id": int64(88), "type": "override"},
	})
	if data["post_id"] != int64(88) {
		t.Fatalf("post_id = %v, want 88", data["post_id"])
	}
	// Producers own their payload: an explicit key overrides the derived one.
	if data["type"] != "override" {
		t.Fatalf("type = %v, want the producer's value", data["type"])
	}
}

func TestMergeDataOmitsZeroEntity(t *testing.T) {
	// A kind with no entity must not send entity_id=0, which the client would
	// happily route on and land on a non-existent screen.
	if _, ok := mergeData(Event{Kind: KindFollow})["entity_id"]; ok {
		t.Fatal("entity_id present for a zero EntityID")
	}
}
