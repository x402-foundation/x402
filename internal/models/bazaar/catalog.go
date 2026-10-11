package bazaar

import "time"

type Provenance string

const (
	ProvenanceSettled  Provenance = "settled"
	ProvenanceVerified Provenance = "verified"
)

type Metrics struct {
	L30DaysTotalCalls     int64     `json:"l30DaysTotalCalls"`
	L30DaysVerifiedCalls  int64     `json:"l30DaysVerifiedCalls"`
	L30DaysSettledCalls   int64     `json:"l30DaysSettledCalls"`
	L30DaysUniquePayers   int64     `json:"l30DaysUniquePayers"`
	LastUpdated           time.Time `json:"lastUpdated"`
}

type CatalogEntry struct {
	ID          string     `json:"id"`
	ResourceURI string     `json:"resourceUri"`
	Provenance  Provenance `json:"provenance"`
	Metrics     Metrics    `json:"metrics"`
}
