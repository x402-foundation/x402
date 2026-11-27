package masumi

// LZString (lz-string 1.5.0) compressToUint8Array and a bounded decoder for its
// output, operating on UTF-16 code units exactly as the JavaScript library.

type lzWriter struct {
	out      []uint16
	val      uint16
	position int
}

func (w *lzWriter) bit(b uint16) {
	w.val = w.val<<1 | b
	if w.position == 15 {
		w.position = 0
		w.out = append(w.out, w.val)
		w.val = 0
	} else {
		w.position++
	}
}

func (w *lzWriter) bits(value, count int) {
	for i := 0; i < count; i++ {
		w.bit(uint16(value & 1))
		value >>= 1
	}
}

func unitsKey(units []uint16) string {
	b := make([]byte, 2*len(units))
	for i, u := range units {
		b[2*i], b[2*i+1] = byte(u>>8), byte(u)
	}
	return string(b)
}

// lzCompressToBytes is LZString.compressToUint8Array over UTF-16 code units.
func lzCompressToBytes(input []uint16) []byte {
	dictionary := map[string]int{}
	toCreate := map[string]bool{}
	var w []uint16
	enlargeIn, dictSize, numBits := 2, 3, 2
	wr := &lzWriter{}

	emitW := func() {
		key := unitsKey(w)
		if toCreate[key] {
			if w[0] < 256 {
				wr.bits(0, numBits)
				wr.bits(int(w[0]), 8)
			} else {
				wr.bits(1, numBits)
				wr.bits(int(w[0]), 16)
			}
			enlargeIn--
			if enlargeIn == 0 {
				enlargeIn = 1 << numBits
				numBits++
			}
			delete(toCreate, key)
		} else {
			wr.bits(dictionary[key], numBits)
		}
		enlargeIn--
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}
	}

	for _, c := range input {
		cKey := unitsKey([]uint16{c})
		if _, ok := dictionary[cKey]; !ok {
			dictionary[cKey] = dictSize
			dictSize++
			toCreate[cKey] = true
		}
		wc := append(append([]uint16{}, w...), c)
		wcKey := unitsKey(wc)
		if _, ok := dictionary[wcKey]; ok {
			w = wc
			continue
		}
		emitW()
		dictionary[wcKey] = dictSize
		dictSize++
		w = []uint16{c}
	}
	if len(w) > 0 {
		emitW()
	}
	wr.bits(2, numBits)
	for {
		wr.val <<= 1
		if wr.position == 15 {
			wr.out = append(wr.out, wr.val)
			break
		}
		wr.position++
	}

	out := make([]byte, 2*len(wr.out))
	for i, u := range wr.out {
		out[2*i], out[2*i+1] = byte(u>>8), byte(u)
	}
	return out
}

// lzDecompressBounded decodes compressToUint8Array output, refusing to produce
// more than maxOutputUnits code units. ok is false for malformed or oversized
// input.
func lzDecompressBounded(compressed []byte, maxOutputUnits int) (out []uint16, ok bool) {
	if len(compressed) == 0 || len(compressed)%2 != 0 || maxOutputUnits <= 0 {
		return nil, false
	}
	unitCount := len(compressed) / 2
	unitAt := func(i int) uint16 { return uint16(compressed[2*i])<<8 | uint16(compressed[2*i+1]) }
	index := 0
	mask := uint16(0x8000)
	current := unitAt(0)
	readBits := func(count int) (int, bool) {
		value, power := 0, 1
		for i := 0; i < count; i++ {
			if index >= unitCount {
				return 0, false
			}
			if current&mask != 0 {
				value |= power
			}
			power <<= 1
			mask >>= 1
			if mask == 0 {
				mask = 0x8000
				index++
				if index < unitCount {
					current = unitAt(index)
				}
			}
		}
		return value, true
	}

	dictionary := [][]uint16{nil, nil, nil}
	enlargeIn, dictSize, numBits := 4, 4, 3

	kind, ok := readBits(2)
	if !ok {
		return nil, false
	}
	if kind == 2 {
		return []uint16{}, true
	}
	width := 8
	if kind == 1 {
		width = 16
	}
	initial, ok := readBits(width)
	if !ok {
		return nil, false
	}
	previous := []uint16{uint16(initial)}
	dictionary = append(dictionary, previous)
	out = append([]uint16{}, previous...)
	if len(out) > maxOutputUnits {
		return nil, false
	}

	for {
		code, ok := readBits(numBits)
		if !ok {
			return nil, false
		}
		switch code {
		case 0, 1:
			width := 8
			if code == 1 {
				width = 16
			}
			literal, ok := readBits(width)
			if !ok {
				return nil, false
			}
			dictionary = setEntry(dictionary, dictSize, []uint16{uint16(literal)})
			code = dictSize
			dictSize++
			enlargeIn--
		case 2:
			return out, true
		}
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}

		var entry []uint16
		if code < len(dictionary) && dictionary[code] != nil {
			entry = dictionary[code]
		} else {
			if code != dictSize {
				return nil, false
			}
			entry = append(append([]uint16{}, previous...), previous[0])
		}
		if len(out)+len(entry) > maxOutputUnits {
			return nil, false
		}
		out = append(out, entry...)

		dictionary = setEntry(dictionary, dictSize, append(append([]uint16{}, previous...), entry[0]))
		dictSize++
		enlargeIn--
		previous = entry

		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}
	}
}

func setEntry(dictionary [][]uint16, index int, entry []uint16) [][]uint16 {
	for len(dictionary) <= index {
		dictionary = append(dictionary, nil)
	}
	dictionary[index] = entry
	return dictionary
}
