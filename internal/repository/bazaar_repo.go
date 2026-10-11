package repository

import (
	"github.com/x402-foundation/x402/internal/models/bazaar"
)

// UpdateBazaarCatalog updates the metrics and provenance of a bazaar entry
func (r *Repo) UpdateBazaarCatalog(info BazaarInfo, prov bazaar.Provenance) error {
	entry, err := r.GetEntry(info.ResourceURI)
	if err != nil {
		// Create new entry if not exists
		entry = &bazaar.CatalogEntry{
			ResourceURI: info.ResourceURI,
			Provenance:  prov,
			Metrics:     bazaar.Metrics{},
		}
	}

	// Update Provenance
	entry.Provenance = prov

	// Update Metrics
	entry.Metrics.L30DaysTotalCalls++
	if prov == bazaar.ProvenanceVerified {
		entry.Metrics.L30DaysVerifiedCalls++
	} else {
		entry.Metrics.L30DaysSettledCalls++
		// Logic to increment UniquePayers would go here based on payer ID
		entry.Metrics.L30DaysUniquePayers = r.incrementUniquePayers(info.ResourceURI, info.Payer)
	}

	return r.SaveEntry(entry)
}
