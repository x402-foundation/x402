package batchsettlement

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// IsNotExist returns true when err is a "file does not exist" error.
func IsNotExist(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, os.ErrNotExist)
}

// ReadJSONFile reads filePath and unmarshals the JSON into out.
// Returns (false, nil) if the file does not exist; (true, nil) on success.
// Other errors (permissions, malformed JSON) are returned as-is.
func ReadJSONFile(filePath string, out interface{}) (bool, error) {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		if IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("read %s: %w", filePath, err)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return false, fmt.Errorf("unmarshal %s: %w", filePath, err)
	}
	return true, nil
}

// WriteJSONAtomic writes value as JSON to filePath atomically (write to temp file
// in the same directory, then rename). Creates parent directories as needed.
func WriteJSONAtomic(filePath string, value interface{}) error {
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	body = append(body, '\n')

	var randSuffix [8]byte
	if _, err := rand.Read(randSuffix[:]); err != nil {
		return fmt.Errorf("rand: %w", err)
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".%d.%s.tmp", os.Getpid(), hex.EncodeToString(randSuffix[:])))
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return fmt.Errorf("write tmp %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, filePath); err != nil {
		// On Windows, rename onto an existing file fails; unlink + rename is intentional.
		_ = os.Remove(filePath)
		if err2 := os.Rename(tmp, filePath); err2 != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("rename %s -> %s: %w", tmp, filePath, err2)
		}
	}
	return nil
}
