// Package events defines the message payloads exchanged between services over
// NATS, so producers and consumers share a single source of truth.
package events

// SubjectRideCompleted is published by the ride service whenever a ride is
// recorded, and consumed by the reward service to evaluate badge rules.
const SubjectRideCompleted = "ride.completed"

// RideCompleted is the payload published on SubjectRideCompleted.
type RideCompleted struct {
	UserID   int64   `json:"user_id"`
	RideID   int64   `json:"ride_id"`
	Distance float64 `json:"distance"`
}
