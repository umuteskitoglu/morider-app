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

// lineEast builds a polyline of n points marching east from a start, one
// ~83 m step (0.001° lon) apart, for overlap tests.
func lineEast(startLat, startLon float64, n int) []geoPoint {
	pts := make([]geoPoint, n)
	for i := 0; i < n; i++ {
		pts[i] = geoPoint{Lat: startLat, Lon: startLon + float64(i)*0.001}
	}
	return pts
}

func TestSegmentsOverlapSameRoad(t *testing.T) {
	a := lineEast(41.0, 29.0, 30)
	b := lineEast(41.0, 29.0, 30) // identical
	if !segmentsOverlap(a, b, segmentOverlapToleranceM, segmentOverlapMinCoverage) {
		t.Error("identical segments should overlap")
	}
}

func TestSegmentsOverlapSubsetStaysDistinct(t *testing.T) {
	// A short stretch inside a much longer run is a valid kapışma of its own, so
	// it must NOT be treated as a duplicate: the long segment covers the short
	// one, but the short one covers only a fraction of the long one.
	long := lineEast(41.0, 29.0, 40)
	short := lineEast(41.0, 29.0+10*0.001, 12) // a 12-pt stretch inside `long`
	if segmentsOverlap(long, short, segmentOverlapToleranceM, segmentOverlapMinCoverage) {
		t.Error("a short segment inside a longer one should stay distinct")
	}
}

func TestSegmentsOverlapNearSameLength(t *testing.T) {
	// The same road drawn slightly differently (one a couple of points shorter)
	// is still one kapışma — they cover each other almost fully.
	a := lineEast(41.0, 29.0, 30)
	b := lineEast(41.0, 29.0, 28)
	if !segmentsOverlap(a, b, segmentOverlapToleranceM, segmentOverlapMinCoverage) {
		t.Error("near-identical co-extensive segments should overlap")
	}
}

func TestSegmentsOverlapParallelRoad(t *testing.T) {
	a := lineEast(41.0, 29.0, 30)
	// ~220 m north (0.002° lat) — a parallel street, well beyond tolerance.
	b := lineEast(41.002, 29.0, 30)
	if segmentsOverlap(a, b, segmentOverlapToleranceM, segmentOverlapMinCoverage) {
		t.Error("a parallel road should not overlap")
	}
}

func TestDedupeSegmentsFoldsDuplicates(t *testing.T) {
	// Two near-identical segments + one distinct road. Pool is liveliest-first,
	// so the first (rider_count 5) must survive and absorb the duplicate.
	pool := []Segment{
		{ID: 1, Distance: 2.4, RiderCount: 5, Points: lineEast(41.0, 29.0, 30)},
		{ID: 2, Distance: 2.4, RiderCount: 2, Points: lineEast(41.0, 29.0, 30)},
		{ID: 3, Distance: 2.4, RiderCount: 1, Points: lineEast(41.02, 29.2, 30)},
	}
	reps := dedupeSegments(pool)
	if len(reps) != 2 {
		t.Fatalf("expected 2 representatives, got %d", len(reps))
	}
	if reps[0].ID != 1 || reps[0].VariantCount != 1 {
		t.Errorf("rep should be segment 1 with 1 folded variant, got id=%d variants=%d", reps[0].ID, reps[0].VariantCount)
	}
	if reps[1].ID != 3 || reps[1].VariantCount != 0 {
		t.Errorf("distinct road should stand alone, got id=%d variants=%d", reps[1].ID, reps[1].VariantCount)
	}
}

func TestHaversineMetersSanity(t *testing.T) {
	// One degree of latitude is ~111 km.
	d := haversineMeters(41.0, 29.0, 42.0, 29.0)
	if d < 110000 || d > 112000 {
		t.Errorf("haversineMeters ~111km expected, got %f", d)
	}
}
