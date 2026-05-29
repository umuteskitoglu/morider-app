package ride

import (
	"math"
	"testing"
	"time"
)

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
