package facilitator

import (
	"github.com/x402-foundation/x402/internal/models/bazaar"
	"github.com/x402-foundation/x402/internal/repository"
)

// HandleVerify processes the /verify route
func (s *Service) HandleVerify(payload *PaymentPayload) (*VerifyResponse, error) {
	// ... existing validation logic ...

	if err := s.validateBazaarExtension(payload); err == nil {
		// Update catalog with 'verified' provenance
		err := s.repo.UpdateBazaarCatalog(payload.BazaarInfo, bazaar.ProvenanceVerified)
		if err != nil {
			return nil, err
		}
	}

	return &VerifyResponse{IsValid: true}, nil
}

// HandleSettle processes the /settle route
func (s *Service) HandleSettle(payload *PaymentPayload) (*SettleResponse, error) {
	// ... existing settlement logic ...

	if err := s.validateBazaarExtension(payload); err == nil {
		// Update catalog with 'settled' provenance
		err := s.repo.UpdateBazaarCatalog(payload.BazaarInfo, bazaar.ProvenanceSettled)
		if err != nil {
			return nil, err
		}
	}

	return &SettleResponse{Status: "success"}, nil
}
