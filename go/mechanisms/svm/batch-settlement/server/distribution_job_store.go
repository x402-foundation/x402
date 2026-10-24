package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// DistributionJob is an immutable distribution request retained until facilitator success.
type DistributionJob struct {
	Version      int                                  `json:"version"`
	ID           string                               `json:"id"`
	Channels     []batchsettlement.BatchSettleChannel `json:"channels"`
	Requirements types.PaymentRequirements            `json:"requirements"`
}

// DistributionJobStore journals work for one active redemption owner. List must
// include every saved, undeleted job, including committed writes whose ack was
// lost. Save must persist before returning, never replace different contents at
// an existing ID, and permit identical retries. Delete removes only that unique
// generation. Eventually consistent enumeration is insufficient. Production
// restart recovery requires durable storage and externally coordinated ownership.
type DistributionJobStore interface {
	List(context.Context) ([]DistributionJob, error)
	Save(context.Context, DistributionJob) error
	Delete(context.Context, string) error
}

// MemoryDistributionJobStore is memory-only. Share it explicitly across managers
// recreated in one process; it does not provide durable restart recovery.
type MemoryDistributionJobStore struct {
	mu    sync.Mutex
	order []string
	jobs  map[string][]byte
}

// NewMemoryDistributionJobStore creates an empty distribution journal.
func NewMemoryDistributionJobStore() *MemoryDistributionJobStore {
	return &MemoryDistributionJobStore{jobs: make(map[string][]byte)}
}

// List returns detached jobs in insertion order, preserving JSON number precision.
func (s *MemoryDistributionJobStore) List(ctx context.Context) ([]DistributionJob, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	jobs := make([]DistributionJob, 0, len(s.order))
	for _, id := range s.order {
		var job DistributionJob
		decoder := json.NewDecoder(bytes.NewReader(s.jobs[id]))
		decoder.UseNumber()
		if err := decoder.Decode(&job); err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}

// Save snapshots a JSON-compatible job without retaining caller-owned maps.
func (s *MemoryDistributionJobStore) Save(ctx context.Context, job DistributionJob) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	encoded, err := json.Marshal(job)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if previous, ok := s.jobs[job.ID]; ok {
		if !bytes.Equal(previous, encoded) {
			return errors.New("distribution job ID already exists")
		}
		return nil
	}
	s.jobs[job.ID] = encoded
	s.order = append(s.order, job.ID)
	return nil
}

// Delete removes only this generation and is idempotent when it is absent.
func (s *MemoryDistributionJobStore) Delete(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.jobs, id)
	s.order = slices.DeleteFunc(s.order, func(existing string) bool { return existing == id })
	return nil
}

func cloneDistributionJob(job DistributionJob) (DistributionJob, error) {
	encoded, err := json.Marshal(job)
	if err != nil {
		return DistributionJob{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var cloned DistributionJob
	if err := decoder.Decode(&cloned); err != nil {
		return DistributionJob{}, err
	}
	return cloned, nil
}
