package svm

import (
	"context"
	"errors"
	"fmt"
	"sync"

	bin "github.com/gagliardetto/binary"
	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/gagliardetto/solana-go/rpc"
)

var (
	ErrMintAccountNotFound     = errors.New("mint account not found")
	ErrUnknownMintTokenProgram = errors.New("unknown token program")
	ErrFailedToDecodeMintData  = errors.New("failed to decode mint data")
)

// MintMetadata contains the stable fields clients need to build SPL transfers.
type MintMetadata struct {
	TokenProgramID solana.PublicKey
	Decimals       uint8
}

// MintMetadataCache caches mint owner and decimals for one client instance.
type MintMetadataCache struct {
	mu      sync.RWMutex
	entries map[mintMetadataCacheKey]MintMetadata
}

type mintMetadataCacheKey struct {
	network string
	mint    solana.PublicKey
}

func NewMintMetadataCache() *MintMetadataCache {
	return &MintMetadataCache{
		entries: make(map[mintMetadataCacheKey]MintMetadata),
	}
}

func (c *MintMetadataCache) GetOrFetch(
	ctx context.Context,
	rpcClient *rpc.Client,
	network string,
	mint solana.PublicKey,
) (MintMetadata, error) {
	key := mintMetadataCacheKey{network: network, mint: mint}

	c.mu.RLock()
	metadata, ok := c.entries[key]
	c.mu.RUnlock()
	if ok {
		return metadata, nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if metadata, ok := c.entries[key]; ok {
		return metadata, nil
	}

	mintAccount, err := rpcClient.GetAccountInfo(ctx, mint)
	if err != nil {
		return MintMetadata{}, err
	}
	if mintAccount == nil || mintAccount.Value == nil {
		return MintMetadata{}, ErrMintAccountNotFound
	}

	tokenProgramID := mintAccount.Value.Owner
	if tokenProgramID != solana.TokenProgramID && tokenProgramID != solana.Token2022ProgramID {
		return MintMetadata{}, ErrUnknownMintTokenProgram
	}

	var mintData token.Mint
	if err := bin.NewBinDecoder(mintAccount.Value.Data.GetBinary()).Decode(&mintData); err != nil {
		return MintMetadata{}, fmt.Errorf("%w: %w", ErrFailedToDecodeMintData, err)
	}

	metadata = MintMetadata{
		TokenProgramID: tokenProgramID,
		Decimals:       mintData.Decimals,
	}

	c.entries[key] = metadata

	return metadata, nil
}
