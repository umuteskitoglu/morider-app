package ride

import (
	"testing"
	"time"
)

// trackAlong builds a synthetic track marching east from a start point, one
// point per second, so timestamps and positions are easy to reason about.
func trackAlong(startLat, startLon float64, n int, stepDegLon float64, base time.Time) []TrackPoint {
	pts := make([]TrackPoint, n)
	for i := 0; i < n; i++ {
		pts[i] = TrackPoint{
			Lat: startLat,
			Lon: startLon + float64(i)*stepDegLon,
			Ts:  base.Add(time.Duration(i) * time.Second),
		}
	}
	return pts
}

func TestMatchSegmentHit(t *testing.T) {
	base := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	// 60-point track marching east at ~0.001° lon steps (~83 m each).
	track := trackAlong(41.0, 29.0, 60, 0.001, base)

	// Segment from the 10th to the 40th track point (exact coords → 0 m off).
	seg := []geoPoint{
		{Lat: 41.0, Lon: 29.0 + 10*0.001},
		{Lat: 41.0, Lon: 29.0 + 40*0.001},
	}
	elapsed, startedAt, ok := matchSegment(track, seg, segmentMatchToleranceM)
	if !ok {
		t.Fatal("expected a match")
	}
	if elapsed != 30 {
		t.Errorf("elapsed = %f, want 30 seconds", elapsed)
	}
	if !startedAt.Equal(base.Add(10 * time.Second)) {
		t.Errorf("startedAt = %v, want %v", startedAt, base.Add(10*time.Second))
	}
}

func TestMatchSegmentTooFar(t *testing.T) {
	base := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	track := trackAlong(41.0, 29.0, 60, 0.001, base)
	// A segment 1° of latitude away (~111 km) — nowhere near the track.
	seg := []geoPoint{
		{Lat: 42.0, Lon: 29.01},
		{Lat: 42.0, Lon: 29.04},
	}
	if _, _, ok := matchSegment(track, seg, segmentMatchToleranceM); ok {
		t.Error("expected no match for a distant segment")
	}
}

func TestMatchSegmentWrongDirection(t *testing.T) {
	base := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	track := trackAlong(41.0, 29.0, 60, 0.001, base)
	// Segment start is later along the track than its end → start must precede end.
	seg := []geoPoint{
		{Lat: 41.0, Lon: 29.0 + 40*0.001},
		{Lat: 41.0, Lon: 29.0 + 10*0.001},
	}
	if _, _, ok := matchSegment(track, seg, segmentMatchToleranceM); ok {
		t.Error("expected no match when the segment is traversed backwards")
	}
}

func TestHaversineMetersSanity(t *testing.T) {
	// One degree of latitude is ~111 km.
	d := haversineMeters(41.0, 29.0, 42.0, 29.0)
	if d < 110000 || d > 112000 {
		t.Errorf("haversineMeters ~111km expected, got %f", d)
	}
}
