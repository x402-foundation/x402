package server_test

import (
	"bytes"
	"context"
	"encoding/gob"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"testing"

	"github.com/stretchr/testify/require"
	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/server"
	"github.com/x402-foundation/x402/go/v2/types"
)

func readyDistribution(id string) server.ChannelState {
	state := newChannel(id)
	state.HighestVoucherSignature = ""
	state.SignedMaxClaimable = 1000
	state.Settled = 1000
	state.ChargedCumulativeAmount = 1000
	return state
}

func distributionJob(id string, members ...string) server.DistributionJob {
	if len(members) == 0 {
		members = []string{"chan-a"}
	}
	job := server.DistributionJob{Version: 1, ID: id, Requirements: managerRequirements()}
	for _, id := range members {
		job.Channels = append(job.Channels, batchsettlement.BatchSettleChannel{ChannelID: id, ChannelConfig: newChannel(id).ChannelConfig})
	}
	return job
}

func distributionOptions(store server.ChannelStore, journal server.DistributionJobStore, settle server.RedemptionSettler) server.BatchChannelManagerConfig {
	return server.BatchChannelManagerConfig{Store: store, DistributionJobStore: journal, Requirements: managerRequirements(), Settle: settle,
		ReadPayoutWatermark: func(context.Context, string) (uint64, bool, error) { return 1000, true, nil }}
}

type faultDistributionJournal struct {
	inner        *server.MemoryDistributionJobStore
	listErr      error
	saveErr      error
	deleteErr    error
	commitSave   bool
	commitDelete bool
	cancelOnSave context.CancelFunc
}

func (s *faultDistributionJournal) List(ctx context.Context) ([]server.DistributionJob, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	return s.inner.List(ctx)
}
func (s *faultDistributionJournal) Save(ctx context.Context, job server.DistributionJob) error {
	if s.saveErr == nil || s.commitSave {
		if err := s.inner.Save(ctx, job); err != nil {
			return err
		}
	}
	if s.cancelOnSave != nil {
		s.cancelOnSave()
	}
	return s.saveErr
}
func (s *faultDistributionJournal) Delete(ctx context.Context, id string) error {
	if s.deleteErr == nil || s.commitDelete {
		if err := s.inner.Delete(ctx, id); err != nil {
			return err
		}
	}
	return s.deleteErr
}

type weakDistributionChannels struct {
	rows     []server.ChannelState
	inner    *server.MemoryChannelStore
	absent   bool
	writeErr error
}

func (s weakDistributionChannels) Get(id string) (*server.ChannelState, error) {
	if s.absent {
		return nil, nil
	}
	return s.inner.Get(id)
}
func (s weakDistributionChannels) Put(state server.ChannelState) error { return s.inner.Put(state) }
func (s weakDistributionChannels) Update(id string, updater func(*server.ChannelState) (server.ChannelState, error)) (server.ChannelState, error) {
	if s.writeErr != nil {
		return server.ChannelState{}, s.writeErr
	}
	return s.inner.Update(id, updater)
}
func (s weakDistributionChannels) List() ([]server.ChannelState, error) { return s.rows, nil }

func TestDistributionJournalRecovery(t *testing.T) {
	ctx := context.Background()
	for _, lost := range []bool{false, true} {
		t.Run(fmt.Sprintf("serialized restart after transport loss=%v", lost), func(t *testing.T) {
			store := server.NewMemoryChannelStore()
			require.NoError(t, store.Put(readyDistribution("chan-a")))
			require.NoError(t, store.Put(readyDistribution("chan-b")))
			journal := server.NewMemoryDistributionJobStore()
			terms := managerRequirements()
			terms.Extra["memo"] = "original"
			terms.Extra["nested"] = map[string]any{"labels": []string{"original"}}
			terms.Extra["large"] = uint64(math.MaxUint64)
			config := distributionOptions(store, journal, func(context.Context, server.RedemptionRequest, types.PaymentRequirements) (*x402.SettleResponse, error) {
				if lost {
					return nil, errors.New("response lost")
				}
				return &x402.SettleResponse{Network: x402.Network(terms.Network), ErrorReason: x402.ErrSettlementPending, Transaction: "original"}, nil
			})
			config.Requirements = terms
			_, err := server.NewBatchChannelManager(config).Redeem(ctx)
			if lost {
				require.ErrorContains(t, err, "response lost")
			} else {
				require.NoError(t, err)
			}
			records, err := journal.List(ctx)
			require.NoError(t, err)
			require.Len(t, records, 1)
			terms.Extra["memo"] = "changed"
			terms.Extra["nested"].(map[string]any)["labels"].([]string)[0] = "changed"
			channelRows, err := store.List()
			require.NoError(t, err)
			channelRows[0].Deposit = math.MaxUint64
			var channelBytes bytes.Buffer
			require.NoError(t, gob.NewEncoder(&channelBytes).Encode(channelRows))
			var restoredRows []server.ChannelState
			require.NoError(t, gob.NewDecoder(&channelBytes).Decode(&restoredRows))
			require.Equal(t, uint64(math.MaxUint64), restoredRows[0].Deposit)
			restoredChannels := server.NewMemoryChannelStore()
			for _, row := range restoredRows {
				require.NoError(t, restoredChannels.Put(row))
			}
			jobBytes, err := json.Marshal(records)
			require.NoError(t, err)
			var restoredJobs []server.DistributionJob
			decoder := json.NewDecoder(bytes.NewReader(jobBytes))
			decoder.UseNumber()
			require.NoError(t, decoder.Decode(&restoredJobs))
			restoredJournal := server.NewMemoryDistributionJobStore()
			for _, job := range restoredJobs {
				require.NoError(t, restoredJournal.Save(ctx, job))
			}
			require.Equal(t, json.Number("18446744073709551615"), restoredJobs[0].Requirements.Extra["large"])
			var calls [][]string
			next := distributionOptions(weakDistributionChannels{inner: restoredChannels}, restoredJournal, func(_ context.Context, request server.RedemptionRequest, accepted types.PaymentRequirements) (*x402.SettleResponse, error) {
				payload := request.Payload.(batchsettlement.BatchSettlePayload)
				ids := []string{}
				for _, entry := range payload.Channels {
					ids = append(ids, entry.ChannelID)
				}
				calls = append(calls, ids)
				require.Equal(t, "original", accepted.Extra["memo"])
				require.Equal(t, "original", accepted.Extra["nested"].(map[string]any)["labels"].([]any)[0])
				accepted.Extra["memo"] = "settler mutation"
				return recoveredResponse(request.Payload), nil
			})
			next.MaxChannelsPerBatch = 1
			next.Requirements.Amount = "999"
			next.Requirements.MaxTimeoutSeconds = 1
			result, err := server.NewBatchChannelManager(next).Redeem(ctx)
			require.NoError(t, err)
			require.Equal(t, []string{"chan-a", "chan-b"}, result.Distributed)
			require.Equal(t, [][]string{{"chan-a", "chan-b"}}, calls)
			remaining, err := restoredJournal.List(ctx)
			require.NoError(t, err)
			require.Empty(t, remaining)
			require.Equal(t, "original", records[0].Requirements.Extra["memo"])
		})
	}

	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprintf("save acknowledgement committed=%v", committed), func(t *testing.T) {
			store := server.NewMemoryChannelStore()
			require.NoError(t, store.Put(readyDistribution("chan-a")))
			memory := server.NewMemoryDistributionJobStore()
			journal := &faultDistributionJournal{inner: memory, saveErr: errors.New("save ack lost"), commitSave: committed}
			recorder := recordingSettler(recoveredResponse)
			manager := server.NewBatchChannelManager(distributionOptions(store, journal, recorder.settle))
			_, err := manager.Redeem(ctx)
			require.ErrorContains(t, err, "save ack lost")
			require.Empty(t, recorder.submitted)
			records, err := memory.List(ctx)
			require.NoError(t, err)
			if committed {
				require.Len(t, records, 1)
			} else {
				require.Empty(t, records)
			}
			journal.saveErr = nil
			_, err = manager.Redeem(ctx)
			require.NoError(t, err)
			require.Len(t, recorder.submitted, 1)
			records, err = memory.List(ctx)
			require.NoError(t, err)
			require.Empty(t, records)
		})
	}

	for _, committed := range []bool{false, true} {
		t.Run(fmt.Sprintf("retirement acknowledgement committed=%v", committed), func(t *testing.T) {
			store := server.NewMemoryChannelStore()
			require.NoError(t, store.Put(readyDistribution("chan-a")))
			memory := server.NewMemoryDistributionJobStore()
			require.NoError(t, memory.Save(ctx, distributionJob("old")))
			journal := &faultDistributionJournal{inner: memory, deleteErr: errors.New("delete ack lost"), commitDelete: committed}
			recorder := recordingSettler(recoveredResponse)
			notify := 0
			config := distributionOptions(store, journal, recorder.settle)
			config.OnSettle = func(server.SettleResult) { notify++ }
			manager := server.NewBatchChannelManager(config)
			_, err := manager.Redeem(ctx)
			require.ErrorContains(t, err, "delete ack lost")
			require.Zero(t, notify)
			records, err := memory.List(ctx)
			require.NoError(t, err)
			if committed {
				require.Empty(t, records)
			} else {
				require.Len(t, records, 1)
			}
			journal.deleteErr = nil
			_, err = manager.Redeem(ctx)
			require.NoError(t, err)
			if committed {
				require.Len(t, recorder.submitted, 1)
			} else {
				require.Len(t, recorder.submitted, 2)
			}
			require.NoError(t, memory.Save(ctx, distributionJob("successor")))
			require.NoError(t, memory.Delete(ctx, "old"))
			records, err = memory.List(ctx)
			require.NoError(t, err)
			require.Len(t, records, 1)
			require.Equal(t, "successor", records[0].ID)
		})
	}

	for _, mode := range []string{"absent", "read failure", "write failure", "newer claim"} {
		t.Run("retires after "+mode, func(t *testing.T) {
			inner := server.NewMemoryChannelStore()
			state := readyDistribution("chan-a")
			if mode == "newer claim" {
				state.Settled = 2000
			}
			require.NoError(t, inner.Put(state))
			memory := server.NewMemoryDistributionJobStore()
			require.NoError(t, memory.Save(ctx, distributionJob("old")))
			store := weakDistributionChannels{inner: inner, absent: mode == "absent"}
			if mode == "write failure" {
				store.writeErr = errors.New("write failed")
			}
			recorder := recordingSettler(recoveredResponse)
			config := distributionOptions(store, memory, recorder.settle)
			var reported []error
			config.OnError = func(err error) { reported = append(reported, err) }
			if mode == "read failure" {
				config.ReadPayoutWatermark = func(context.Context, string) (uint64, bool, error) { return 0, false, errors.New("read failed") }
			}
			notify := 0
			config.OnSettle = func(server.SettleResult) { notify++ }
			result, err := server.NewBatchChannelManager(config).Redeem(ctx)
			require.NoError(t, err)
			require.Empty(t, result.Distributed)
			require.Zero(t, notify)
			records, err := memory.List(ctx)
			require.NoError(t, err)
			require.Empty(t, records)
			if mode != "newer claim" {
				require.Len(t, reported, 1)
			}
			stored, err := inner.Get("chan-a")
			require.NoError(t, err)
			if mode == "newer claim" {
				require.Equal(t, uint64(1000), stored.PayoutWatermark)
			} else {
				require.Zero(t, stored.PayoutWatermark)
			}
		})
	}

	t.Run("claim and recovery failures do not starve independent payouts", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		for _, id := range []string{"chan-a", "chan-b"} {
			require.NoError(t, store.Put(readyDistribution(id)))
		}
		require.NoError(t, store.Put(newChannel("claim-fails")))
		memory := server.NewMemoryDistributionJobStore()
		require.NoError(t, memory.Save(ctx, distributionJob("old")))
		var seen []string
		config := distributionOptions(store, memory, func(_ context.Context, request server.RedemptionRequest, _ types.PaymentRequirements) (*x402.SettleResponse, error) {
			kind, ids := redemptionFacts(request.Payload)
			if kind == batchsettlement.PayloadTypeClaim {
				return nil, errors.New("claim unavailable")
			}
			seen = append(seen, ids[0])
			if ids[0] == "chan-a" {
				return nil, errors.New("accounting unavailable")
			}
			return recoveredResponse(request.Payload), nil
		})
		_, err := server.NewBatchChannelManager(config).Redeem(ctx)
		require.ErrorContains(t, err, "claim unavailable")
		require.ErrorContains(t, err, "accounting unavailable")
		require.Equal(t, []string{"chan-a", "chan-b"}, seen)
		records, err := memory.List(ctx)
		require.NoError(t, err)
		require.Len(t, records, 1)
		require.Equal(t, "old", records[0].ID)
	})

	for _, mode := range []string{"list failure", "version", "duplicate member", "overlap", "scope rotation"} {
		t.Run("rejects "+mode, func(t *testing.T) {
			store := server.NewMemoryChannelStore()
			require.NoError(t, store.Put(readyDistribution("chan-b")))
			memory := server.NewMemoryDistributionJobStore()
			job := distributionJob("old")
			switch mode {
			case "version":
				job.Version = 2
			case "duplicate member":
				job.Channels = append(job.Channels, job.Channels[0])
			case "scope rotation":
				job.Requirements.Extra[batchsettlement.ExtraFeePayer] = "rotated"
			}
			require.NoError(t, memory.Save(ctx, job))
			if mode == "overlap" {
				require.NoError(t, memory.Save(ctx, distributionJob("another")))
			}
			journal := &faultDistributionJournal{inner: memory}
			if mode == "list failure" {
				journal.listErr = errors.New("journal unavailable")
			}
			recorder := recordingSettler(recoveredResponse)
			_, err := server.NewBatchChannelManager(distributionOptions(store, journal, recorder.settle)).Redeem(ctx)
			require.Error(t, err)
			require.Empty(t, recorder.submitted)
			records, err := memory.List(ctx)
			require.NoError(t, err)
			require.NotEmpty(t, records)
		})
	}

	t.Run("immutable snapshots and unique generation deletion", func(t *testing.T) {
		memory := server.NewMemoryDistributionJobStore()
		job := distributionJob("old")
		job.Requirements.Extra["nested"] = map[string]any{"values": []string{"original"}}
		require.NoError(t, memory.Save(ctx, job))
		require.NoError(t, memory.Save(ctx, job))
		job.Channels[0].ChannelConfig.Salt = "changed"
		records, err := memory.List(ctx)
		require.NoError(t, err)
		records[0].Requirements.Extra["nested"].(map[string]any)["values"].([]any)[0] = "changed"
		fresh, err := memory.List(ctx)
		require.NoError(t, err)
		require.Equal(t, "0", fresh[0].Channels[0].ChannelConfig.Salt)
		require.Equal(t, "original", fresh[0].Requirements.Extra["nested"].(map[string]any)["values"].([]any)[0])
		require.ErrorContains(t, memory.Save(ctx, job), "already exists")
		bad := distributionJob("bad")
		bad.Requirements.Extra["unsupported"] = func() {}
		require.Error(t, memory.Save(ctx, bad))
	})

	t.Run("cancellation prevents further sends", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(readyDistribution("chan-a")))
		memory := server.NewMemoryDistributionJobStore()
		require.NoError(t, memory.Save(ctx, distributionJob("old")))
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		recorder := recordingSettler(recoveredResponse)
		_, err := server.NewBatchChannelManager(distributionOptions(store, memory, recorder.settle)).Redeem(cancelled)
		require.ErrorIs(t, err, context.Canceled)
		require.Empty(t, recorder.submitted)
	})
	t.Run("cancellation during successful save retains intent without sending", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(readyDistribution("chan-a")))
		memory := server.NewMemoryDistributionJobStore()
		cancelled, cancel := context.WithCancel(ctx)
		defer cancel()
		journal := &faultDistributionJournal{inner: memory, cancelOnSave: cancel}
		recorder := recordingSettler(recoveredResponse)
		_, err := server.NewBatchChannelManager(distributionOptions(store, journal, recorder.settle)).Redeem(cancelled)
		require.ErrorIs(t, err, context.Canceled)
		require.Empty(t, recorder.submitted)
		records, err := memory.List(ctx)
		require.NoError(t, err)
		require.Len(t, records, 1)
	})
	t.Run("retires before panicking local error notification", func(t *testing.T) {
		inner := server.NewMemoryChannelStore()
		require.NoError(t, inner.Put(readyDistribution("chan-a")))
		journal := server.NewMemoryDistributionJobStore()
		require.NoError(t, journal.Save(ctx, distributionJob("old")))
		recorder := recordingSettler(recoveredResponse)
		config := distributionOptions(weakDistributionChannels{inner: inner, absent: true}, journal, recorder.settle)
		config.OnError = func(error) { panic("notification failed") }
		require.Panics(t, func() { _, _ = server.NewBatchChannelManager(config).Redeem(ctx) })
		records, err := journal.List(ctx)
		require.NoError(t, err)
		require.Empty(t, records)
	})
	for _, kind := range []string{"claim", "seal"} {
		t.Run("journal discovery failure preserves urgent "+kind, func(t *testing.T) {
			store := server.NewMemoryChannelStore()
			state := newChannel("urgent")
			if kind == "seal" {
				state.Status = server.ChannelStatusClosing
			}
			require.NoError(t, store.Put(state))
			journal := &faultDistributionJournal{inner: server.NewMemoryDistributionJobStore(), listErr: errors.New("journal unavailable")}
			recorder := recordingSettler(recoveredResponse)
			_, err := server.NewBatchChannelManager(distributionOptions(store, journal, recorder.settle)).Redeem(ctx)
			require.ErrorContains(t, err, "journal unavailable")
			require.Equal(t, []string{kind}, payloadTypes(recorder.submitted))
		})
	}
	for _, status := range []string{server.ChannelStatusClosing, server.ChannelStatusDistributed} {
		t.Run("replays channel now "+status, func(t *testing.T) {
			store := server.NewMemoryChannelStore()
			state := readyDistribution("chan-a")
			state.Status = status
			require.NoError(t, store.Put(state))
			journal := server.NewMemoryDistributionJobStore()
			require.NoError(t, journal.Save(ctx, distributionJob("old")))
			recorder := recordingSettler(recoveredResponse)
			result, err := server.NewBatchChannelManager(distributionOptions(store, journal, recorder.settle)).Redeem(ctx)
			require.NoError(t, err)
			require.Equal(t, []string{"chan-a"}, result.Distributed)
			require.Len(t, recorder.submitted, 1)
			records, err := journal.List(ctx)
			require.NoError(t, err)
			require.Empty(t, records)
		})
	}
	t.Run("explicit default voucher mode preserves original request", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(readyDistribution("chan-a")))
		journal := server.NewMemoryDistributionJobStore()
		require.NoError(t, journal.Save(ctx, distributionJob("old")))
		config := distributionOptions(store, journal, func(_ context.Context, request server.RedemptionRequest, terms types.PaymentRequirements) (*x402.SettleResponse, error) {
			_, present := terms.Extra[batchsettlement.ExtraVoucherSigner]
			require.False(t, present)
			return recoveredResponse(request.Payload), nil
		})
		config.Requirements.Extra[batchsettlement.ExtraVoucherSigner] = "client"
		config.Requirements.Extra[batchsettlement.ExtraOperator] = "irrelevant-to-client-mode"
		_, err := server.NewBatchChannelManager(config).Redeem(ctx)
		require.NoError(t, err)
	})
	t.Run("duplicate fresh rows are rejected before save and send", func(t *testing.T) {
		inner := server.NewMemoryChannelStore()
		require.NoError(t, inner.Put(readyDistribution("chan-a")))
		journal := server.NewMemoryDistributionJobStore()
		recorder := recordingSettler(recoveredResponse)
		store := weakDistributionChannels{inner: inner, rows: []server.ChannelState{readyDistribution("chan-a"), readyDistribution("chan-a")}}
		_, err := server.NewBatchChannelManager(distributionOptions(store, journal, recorder.settle)).Redeem(ctx)
		require.ErrorContains(t, err, "overlapping")
		require.Empty(t, recorder.submitted)
		records, err := journal.List(ctx)
		require.NoError(t, err)
		require.Empty(t, records)
	})

	t.Run("pending accounting permits unrelated payouts", func(t *testing.T) {
		store := server.NewMemoryChannelStore()
		require.NoError(t, store.Put(readyDistribution("chan-a")))
		require.NoError(t, store.Put(readyDistribution("chan-b")))
		journal := server.NewMemoryDistributionJobStore()
		require.NoError(t, journal.Save(ctx, distributionJob("old")))
		pending := true
		var seen []string
		config := distributionOptions(store, journal, func(_ context.Context, request server.RedemptionRequest, terms types.PaymentRequirements) (*x402.SettleResponse, error) {
			_, ids := redemptionFacts(request.Payload)
			seen = append(seen, ids[0])
			if ids[0] == "chan-a" && pending {
				return &x402.SettleResponse{Network: x402.Network(terms.Network), ErrorReason: x402.ErrSettlementPending, Transaction: "original"}, nil
			}
			return recoveredResponse(request.Payload), nil
		})
		manager := server.NewBatchChannelManager(config)
		result, err := manager.Redeem(ctx)
		require.NoError(t, err)
		require.Equal(t, []string{"chan-b"}, result.Distributed)
		records, err := journal.List(ctx)
		require.NoError(t, err)
		require.Len(t, records, 1)
		require.Equal(t, "old", records[0].ID)
		pending = false
		result, err = manager.Redeem(ctx)
		require.NoError(t, err)
		require.Equal(t, []string{"chan-a"}, result.Distributed)
		require.Equal(t, []string{"chan-a", "chan-b", "chan-a"}, seen)
		records, err = journal.List(ctx)
		require.NoError(t, err)
		require.Empty(t, records)
	})

}
