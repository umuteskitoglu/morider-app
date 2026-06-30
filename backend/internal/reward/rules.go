package reward

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Badge is an achievement the rules engine can grant. Type is the stable,
// machine identifier (also the idempotency key per user); Description is the
// human-facing text stored alongside it; Tier is its rarity, which determines
// the XP it awards.
type Badge struct {
	Type        string
	Description string
	Tier        string // bronze | silver | gold | platinum
}

// Tier constants and their XP values. XP is a pure function of tier so badges
// have a single source of difficulty.
const (
	TierBronze   = "bronze"
	TierSilver   = "silver"
	TierGold     = "gold"
	TierPlatinum = "platinum"
)

// TierXP returns the XP awarded for a badge of the given tier.
func TierXP(tier string) int {
	switch tier {
	case TierBronze:
		return 10
	case TierSilver:
		return 25
	case TierGold:
		return 50
	case TierPlatinum:
		return 100
	default:
		return 0
	}
}

// BadgeMeta resolves a stored reward type back to its tier and XP. Static badges
// come from the rule set; a completed challenge (challenge_<id>) counts as gold.
func BadgeMeta(badgeType string) (tier string, xp int) {
	for _, r := range rules {
		if r.badge.Type == badgeType {
			return r.badge.Tier, TierXP(r.badge.Tier)
		}
	}
	if strings.HasPrefix(badgeType, "challenge_") {
		return TierGold, TierXP(TierGold)
	}
	return "special", 0
}

// Level maps total XP to a rider level and progress within that level. Level n
// starts at cumulative XP 50*n*(n-1): 0, 100, 300, 600, 1000, ... so each level
// costs 100 XP more than the last. into is XP earned inside the current level and
// span is the XP the current level spans.
func Level(xp int) (level, into, span int) {
	if xp < 0 {
		xp = 0
	}
	cum := func(n int) int { return 50 * n * (n - 1) }
	level = 1
	for cum(level+1) <= xp {
		level++
	}
	into = xp - cum(level)
	span = cum(level+1) - cum(level)
	return level, into, span
}

// Stats is the aggregate riding history a rule is evaluated against. It is the
// only input to the rules, which keeps rule evaluation pure and unit-testable.
type Stats struct {
	RideCount         int64
	TotalDistance     float64 // total km across all rides
	LongestRide       float64 // longest single ride in km
	LongestStreak     int     // longest run of consecutive calendar days with a ride
	BestWeekDistance  float64 // most km ridden within a single ISO week
	BestMonthDistance float64 // most km ridden within a single calendar month
	MaxAvgSpeed       float64 // highest single-ride average speed in km/h
	GroupRideCount    int64   // distinct group rides joined that had 2+ participants
	MaxGroupSize      int64   // largest participant count among joined group rides
	SegmentEfforts    int64   // distinct segments the rider has posted an effort on
}

// RidePoint pairs a ride's timestamp with its distance. It is the input to the
// period-based aggregations (weekly/monthly), kept separate from DB access so
// the bucketing logic stays pure and testable.
type RidePoint struct {
	At       time.Time
	Distance float64
}

// rule pairs a badge with the predicate that earns it.
type rule struct {
	badge  Badge
	earned func(Stats) bool
}

// rules is the ordered rule set. Add new badges here; the engine and the API
// stay unchanged. Mirrors the examples in Morider-app.md §8.
var rules = []rule{
	// Volume / count
	{Badge{"first_ride", "İlk sürüş tamamlandı", TierBronze}, func(s Stats) bool { return s.RideCount >= 1 }},
	{Badge{"rider_10", "10 sürüş tamamlandı", TierSilver}, func(s Stats) bool { return s.RideCount >= 10 }},
	{Badge{"rider_50", "50 sürüş tamamlandı", TierGold}, func(s Stats) bool { return s.RideCount >= 50 }},

	// Single ride distance
	{Badge{"century_ride", "Tek sürüşte 100 km", TierBronze}, func(s Stats) bool { return s.LongestRide >= 100 }},
	{Badge{"long_hauler", "Tek sürüşte 300 km", TierSilver}, func(s Stats) bool { return s.LongestRide >= 300 }},

	// Total distance
	{Badge{"club_1000", "1000 km kulübü", TierSilver}, func(s Stats) bool { return s.TotalDistance >= 1000 }},
	{Badge{"club_10000", "10.000 km kulübü", TierGold}, func(s Stats) bool { return s.TotalDistance >= 10000 }},

	// Weekly distance
	{Badge{"week_300", "Bir haftada 300 km", TierBronze}, func(s Stats) bool { return s.BestWeekDistance >= 300 }},
	{Badge{"week_700", "Bir haftada 700 km", TierSilver}, func(s Stats) bool { return s.BestWeekDistance >= 700 }},

	// Monthly distance
	{Badge{"month_1000", "Bir ayda 1000 km", TierBronze}, func(s Stats) bool { return s.BestMonthDistance >= 1000 }},
	{Badge{"month_3000", "Bir ayda 3000 km", TierSilver}, func(s Stats) bool { return s.BestMonthDistance >= 3000 }},

	// Streak
	{Badge{"streak_7", "7 gün aralıksız sürüş", TierBronze}, func(s Stats) bool { return s.LongestStreak >= 7 }},
	{Badge{"streak_30", "30 gün aralıksız sürüş", TierSilver}, func(s Stats) bool { return s.LongestStreak >= 30 }},

	// Speed (average speed of a single ride). MaxAvgSpeed is sanity-capped at the
	// data layer to ignore implausible GPS spikes; full anti-cheat is future work.
	{Badge{"speedster_100", "Ortalama 100 km/s sürüş", TierBronze}, func(s Stats) bool { return s.MaxAvgSpeed >= 100 }},
	{Badge{"speedster_140", "Ortalama 140 km/s sürüş", TierSilver}, func(s Stats) bool { return s.MaxAvgSpeed >= 140 }},

	// Group rides (sessions ridden with at least one other rider).
	{Badge{"group_first", "İlk grup sürüşü", TierBronze}, func(s Stats) bool { return s.GroupRideCount >= 1 }},
	{Badge{"group_5", "5 grup sürüşü", TierSilver}, func(s Stats) bool { return s.GroupRideCount >= 5 }},
	{Badge{"group_20", "20 grup sürüşü", TierGold}, func(s Stats) bool { return s.GroupRideCount >= 20 }},

	// Group size (largest pack ridden with).
	{Badge{"pack_5", "5 kişilik grupla sürüş", TierBronze}, func(s Stats) bool { return s.MaxGroupSize >= 5 }},
	{Badge{"pack_10", "10 kişilik grupla sürüş", TierSilver}, func(s Stats) bool { return s.MaxGroupSize >= 10 }},

	// Segments (timed efforts posted on rider-defined stretches of road).
	{Badge{"segment_first", "İlk segment denemesi", TierBronze}, func(s Stats) bool { return s.SegmentEfforts >= 1 }},
	{Badge{"segment_10", "10 segmentte deneme", TierSilver}, func(s Stats) bool { return s.SegmentEfforts >= 10 }},
}

// Evaluate returns every badge earned for the given stats, in rule order.
func Evaluate(s Stats) []Badge {
	earned := make([]Badge, 0, len(rules))
	for _, r := range rules {
		if r.earned(s) {
			earned = append(earned, r.badge)
		}
	}
	return earned
}

// LongestStreak returns the length of the longest run of consecutive calendar
// days present in days. Inputs need not be sorted or unique; each timestamp is
// reduced to its UTC date so multiple rides on the same day count once.
func LongestStreak(days []time.Time) int {
	if len(days) == 0 {
		return 0
	}
	unique := make(map[time.Time]struct{}, len(days))
	for _, d := range days {
		day := utcDate(d)
		unique[day] = struct{}{}
	}
	sorted := make([]time.Time, 0, len(unique))
	for day := range unique {
		sorted = append(sorted, day)
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Before(sorted[j]) })

	best, current := 1, 1
	for i := 1; i < len(sorted); i++ {
		if sorted[i].Sub(sorted[i-1]) == 24*time.Hour {
			current++
		} else {
			current = 1
		}
		if current > best {
			best = current
		}
	}
	return best
}

// BestWeekDistance returns the highest total distance ridden within any single
// ISO week (Monday-based), across the supplied rides.
func BestWeekDistance(rides []RidePoint) float64 {
	return bestBucketDistance(rides, func(t time.Time) string {
		y, w := t.UTC().ISOWeek()
		return fmt.Sprintf("%04d-W%02d", y, w)
	})
}

// BestMonthDistance returns the highest total distance ridden within any single
// calendar month, across the supplied rides.
func BestMonthDistance(rides []RidePoint) float64 {
	return bestBucketDistance(rides, func(t time.Time) string {
		return t.UTC().Format("2006-01")
	})
}

// bestBucketDistance sums ride distances per bucket key and returns the largest
// bucket total.
func bestBucketDistance(rides []RidePoint, bucket func(time.Time) string) float64 {
	totals := make(map[string]float64)
	var best float64
	for _, r := range rides {
		k := bucket(r.At)
		totals[k] += r.Distance
		if totals[k] > best {
			best = totals[k]
		}
	}
	return best
}

func utcDate(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
}
