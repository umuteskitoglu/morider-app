package ride

import (
	"math"
	"testing"
	"time"
)

func TestTruncWeek(t *testing.T) {
	// All days within an ISO week (Mon 2026-06-08 .. Sun 2026-06-14) must
	// collapse to that Monday at 00:00.
	monday := time.Date(2026, 6, 8, 0, 0, 0, 0, time.UTC)
	for d := 0; d < 7; d++ {
		day := time.Date(2026, 6, 8+d, 13, 37, 5, 0, time.UTC)
		if got := truncWeek(day); !got.Equal(monday) {
			t.Fatalf("truncWeek(%v) = %v, want %v", day, got, monday)
		}
	}
}

func TestAvgSpeed(t *testing.T) {
	cases := []struct {
		name     string
		distance float64
		dur      time.Duration
		want     float64
	}{
		{"one hour", 90, time.Hour, 90},
		{"half hour", 45, 30 * time.Minute, 90},
		{"zero duration", 50, 0, 0},
		{"negative duration", 50, -time.Hour, 0},
		{"two hours", 200, 2 * time.Hour, 100},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := AvgSpeed(tc.distance, tc.dur)
			if math.Abs(got-tc.want) > 1e-9 {
				t.Fatalf("AvgSpeed(%v, %v) = %v, want %v", tc.distance, tc.dur, got, tc.want)
			}
		})
	}
}
