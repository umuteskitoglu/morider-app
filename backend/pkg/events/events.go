// Package events defines the message payloads exchanged between services over
// NATS, so producers and consumers share a single source of truth.
package events

import "fmt"

// SubjectRideCompleted is published by the ride service whenever a ride is
// recorded, and consumed by the reward service to evaluate badge rules.
const SubjectRideCompleted = "ride.completed"

// RideCompleted is the payload published on SubjectRideCompleted.
type RideCompleted struct {
	UserID   int64   `json:"user_id"`
	RideID   int64   `json:"ride_id"`
	Distance float64 `json:"distance"`
}

// SubjectSessionPositions returns the NATS subject carrying live GPS positions
// for a group ride session. Each telemetry replica subscribes to this subject so
// participant positions fan out across replicas.
func SubjectSessionPositions(sessionID int64) string {
	return fmt.Sprintf("session.%d.positions", sessionID)
}

// LivePosition is a single participant's live position within a group ride
// session, published on SubjectSessionPositions and forwarded to other
// participants' WebSocket connections.
type LivePosition struct {
	SessionID int64   `json:"session_id"`
	UserID    int64   `json:"user_id"`
	Name      string  `json:"name"`
	Lat       float64 `json:"lat"`
	Lon       float64 `json:"lon"`
	Speed     float64 `json:"speed"`
	Ts        int64   `json:"ts"` // unix milliseconds
}
