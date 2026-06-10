package route

import (
	"math"
	"sort"
)

// curvinessScore measures how twisty a polyline is: the sum of absolute
// heading changes (degrees) divided by total length (km). A motorway scores
// near 0; a mountain pass easily exceeds 100.
func curvinessScore(points []Point) float64 {
	if len(points) < 3 {
		return 0
	}
	var totalTurn, totalKm float64
	prevBearing := bearing(points[0], points[1])
	totalKm = haversineKm(points[0], points[1])
	for i := 1; i < len(points)-1; i++ {
		b := bearing(points[i], points[i+1])
		totalTurn += math.Abs(angleDiff(b, prevBearing))
		totalKm += haversineKm(points[i], points[i+1])
		prevBearing = b
	}
	if totalKm <= 0 {
		return 0
	}
	return totalTurn / totalKm
}

// pickByCurviness orders the plans from straightest to curviest and returns
// the one matching the requested level in [0,1] (0 → straightest, 1 →
// curviest, values in between interpolate over the available alternatives).
func pickByCurviness(plans []RoutePlan, level float64) RoutePlan {
	if len(plans) == 1 {
		return plans[0]
	}
	sorted := make([]RoutePlan, len(plans))
	copy(sorted, plans)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Curviness < sorted[j].Curviness })
	level = math.Max(0, math.Min(1, level))
	idx := int(math.Round(level * float64(len(sorted)-1)))
	return sorted[idx]
}

// haversineKm is the great-circle distance between two points in km.
func haversineKm(a, b Point) float64 {
	const earthRadiusKm = 6371.0
	la1, la2 := a.Lat*math.Pi/180, b.Lat*math.Pi/180
	dLat := (b.Lat - a.Lat) * math.Pi / 180
	dLon := (b.Lon - a.Lon) * math.Pi / 180
	h := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(la1)*math.Cos(la2)*math.Sin(dLon/2)*math.Sin(dLon/2)
	return 2 * earthRadiusKm * math.Asin(math.Sqrt(h))
}

// bearing is the initial compass bearing from a to b in degrees [0,360).
func bearing(a, b Point) float64 {
	la1, la2 := a.Lat*math.Pi/180, b.Lat*math.Pi/180
	dLon := (b.Lon - a.Lon) * math.Pi / 180
	y := math.Sin(dLon) * math.Cos(la2)
	x := math.Cos(la1)*math.Sin(la2) - math.Sin(la1)*math.Cos(la2)*math.Cos(dLon)
	deg := math.Atan2(y, x) * 180 / math.Pi
	return math.Mod(deg+360, 360)
}

// angleDiff is the signed smallest difference between two bearings, in
// [-180, 180). Callers only use its magnitude.
func angleDiff(a, b float64) float64 {
	d := math.Mod(a-b+540, 360) - 180
	return d
}
