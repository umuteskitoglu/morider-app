package reward

import (
	"testing"
	"time"
)

func hasBadge(badges []Badge, typ string) bool {
	for _, b := range badges {
		if b.Type == typ {
			return true
		}
	}
	return false
}

func TestEvaluate(t *testing.T) {
	cases := []struct {
		name   string
		stats  Stats
		want   []string // badge types expected to be present
		absent []string // badge types expected to be absent
	}{
		{
			name:   "no rides",
			stats:  Stats{},
			absent: []string{"first_ride", "rider_10", "century_ride", "long_hauler", "club_1000", "streak_7"},
		},
		{
			name:   "single short ride",
			stats:  Stats{RideCount: 1, TotalDistance: 20, LongestRide: 20, LongestStreak: 1},
			want:   []string{"first_ride"},
			absent: []string{"rider_10", "century_ride", "club_1000", "streak_7"},
		},
		{
			name:   "century ride but not long hauler",
			stats:  Stats{RideCount: 3, TotalDistance: 250, LongestRide: 120, LongestStreak: 2},
			want:   []string{"first_ride", "century_ride"},
			absent: []string{"long_hauler", "rider_10", "club_1000"},
		},
		{
			name: "veteran rider hits everything",
			stats: Stats{
				RideCount: 60, TotalDistance: 12000, LongestRide: 350, LongestStreak: 31,
				BestWeekDistance: 800, BestMonthDistance: 3200, MaxAvgSpeed: 150,
			},
			want: []string{
				"first_ride", "rider_10", "rider_50", "century_ride", "long_hauler",
				"club_1000", "club_10000", "week_300", "week_700", "month_1000",
				"month_3000", "streak_7", "streak_30", "speedster_100", "speedster_140",
			},
		},
		{
			name:   "exact thresholds are inclusive",
			stats:  Stats{RideCount: 10, TotalDistance: 1000, LongestRide: 100, LongestStreak: 7},
			want:   []string{"rider_10", "century_ride", "club_1000", "streak_7"},
			absent: []string{"long_hauler", "rider_50", "club_10000", "streak_30"},
		},
		{
			name:   "weekly badge without monthly threshold",
			stats:  Stats{RideCount: 5, TotalDistance: 400, BestWeekDistance: 350, BestMonthDistance: 400},
			want:   []string{"first_ride", "week_300"},
			absent: []string{"week_700", "month_1000"},
		},
		{
			name:   "speed badges by max avg speed",
			stats:  Stats{RideCount: 1, MaxAvgSpeed: 120},
			want:   []string{"first_ride", "speedster_100"},
			absent: []string{"speedster_140"},
		},
		{
			name:   "first group ride in a pair",
			stats:  Stats{GroupRideCount: 1, MaxGroupSize: 2},
			want:   []string{"group_first"},
			absent: []string{"group_5", "pack_5"},
		},
		{
			name:  "many group rides in big packs",
			stats: Stats{GroupRideCount: 20, MaxGroupSize: 10},
			want:  []string{"group_first", "group_5", "group_20", "pack_5", "pack_10"},
		},
		{
			name:   "solo session does not earn group badges",
			stats:  Stats{GroupRideCount: 0, MaxGroupSize: 1},
			absent: []string{"group_first", "pack_5"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Evaluate(tc.stats)
			for _, typ := range tc.want {
				if !hasBadge(got, typ) {
					t.Errorf("expected badge %q to be earned, got %v", typ, got)
				}
			}
			for _, typ := range tc.absent {
				if hasBadge(got, typ) {
					t.Errorf("badge %q should not be earned for %+v", typ, tc.stats)
				}
			}
		})
	}
}

func TestLongestStreak(t *testing.T) {
	day := func(y int, m time.Month, d int) time.Time {
		return time.Date(y, m, d, 12, 0, 0, 0, time.UTC)
	}

	cases := []struct {
		name string
		days []time.Time
		want int
	}{
		{"empty", nil, 0},
		{"single", []time.Time{day(2026, 5, 1)}, 1},
		{
			name: "three consecutive",
			days: []time.Time{day(2026, 5, 1), day(2026, 5, 2), day(2026, 5, 3)},
			want: 3,
		},
		{
			name: "duplicates same day count once",
			days: []time.Time{day(2026, 5, 1), day(2026, 5, 1), day(2026, 5, 2)},
			want: 2,
		},
		{
			name: "gap resets streak",
			days: []time.Time{day(2026, 5, 1), day(2026, 5, 2), day(2026, 5, 5), day(2026, 5, 6), day(2026, 5, 7)},
			want: 3,
		},
		{
			name: "unsorted input",
			days: []time.Time{day(2026, 5, 3), day(2026, 5, 1), day(2026, 5, 2)},
			want: 3,
		},
		{
			name: "crosses month boundary",
			days: []time.Time{day(2026, 5, 30), day(2026, 5, 31), day(2026, 6, 1)},
			want: 3,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := LongestStreak(tc.days); got != tc.want {
				t.Errorf("LongestStreak(%v) = %d, want %d", tc.days, got, tc.want)
			}
		})
	}
}

func TestBestWeekDistance(t *testing.T) {
	at := func(y int, m time.Month, d int) time.Time {
		return time.Date(y, m, d, 10, 0, 0, 0, time.UTC)
	}
	rides := []RidePoint{
		// ISO week 1 of 2026 (Mon 2025-12-29 .. Sun 2026-01-04)
		{at(2025, 12, 30), 100},
		{at(2026, 1, 2), 50},
		// ISO week 2 (2026-01-05 .. 2026-01-11)
		{at(2026, 1, 6), 200},
		{at(2026, 1, 7), 120},
	}
	if got := BestWeekDistance(rides); got != 320 {
		t.Errorf("BestWeekDistance = %v, want 320", got)
	}
	if got := BestWeekDistance(nil); got != 0 {
		t.Errorf("BestWeekDistance(nil) = %v, want 0", got)
	}
}

func TestBestMonthDistance(t *testing.T) {
	at := func(y int, m time.Month, d int) time.Time {
		return time.Date(y, m, d, 10, 0, 0, 0, time.UTC)
	}
	rides := []RidePoint{
		{at(2026, 5, 1), 400},
		{at(2026, 5, 20), 700}, // May total 1100
		{at(2026, 6, 3), 300},  // June total 300
	}
	if got := BestMonthDistance(rides); got != 1100 {
		t.Errorf("BestMonthDistance = %v, want 1100", got)
	}
}
