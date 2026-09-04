# Bazaar discovery filter conformance

These vectors exercise the filter rules in
[`bazaar.md`](bazaar.md#filter-semantics) over unauthenticated HTTP. They target
`GET /discovery/resources`, whose result array is `items`. Search is not exercised
because `GET /discovery/search` also requires a catalog-specific `query`.

## Assertion

For a well-formed filter value, a `200` response conforms when:

- `unappliedFilters` names the parameter; or
- every returned item satisfies the filter, with `items: []` and
  `pagination.total: 0` (when `total` is present) when nothing matches.

For malformed input, `400` also conforms when the JSON response has a non-empty string
`error` member; otherwise the same `200` rules apply. A `400` for a well-formed value
does not conform. Other HTTP statuses, an invalid response shape, or a transport failure
make the run incomplete rather than passing it.

The well-formed probes use values a real client may send. They are not assumed to be
unmatched: when a catalog contains a value, every returned item must carry it.

## Vectors

`BASE` is the implementation's query-free `/discovery/resources` URL.

| ID | Parameter | Value class | Value |
|---|---|---|---|
| V0 | none | baseline | `?limit=50` |
| V1 | `type` | well-formed | `mcp` |
| V2 | `payTo` | well-formed | `0x0000000000000000000000000000000000000001` |
| V3 | `scheme` | well-formed | `batch-settlement` |
| V4 | `network` | well-formed | `eip155:999999999` |
| V5 | `extensions` | well-formed | `payment-identifier` |
| V6 | `network` | malformed | `!!!` |
| V7 | `network` | positive control | least-common network present on some, but not all, V0 items |

V7 proves the runner can distinguish a filtered subset from the baseline. If the first
page has no network present on both matching and non-matching items, V7 is incomplete; an
identical one-network result is not mislabeled as a conformance failure.

## Run

```bash
bash run_bazaar_discovery_vectors.sh --self-test
bash run_bazaar_discovery_vectors.sh https://example.com/discovery/resources
```

The self-test covers assertion branches and end-to-end exit codes. The live runner reports
HTTP status, reports the V0 SHA-256 digest, and notes byte-identical failures. Temporary
response bodies are removed after the run, and each response is limited to 10 MiB.

Exit status is `0` when every vector conforms, `1` when at least one vector fails, and
`2` when any vector cannot be evaluated. These vectors cover filter honesty only; they
do not test search, ranking, pagination stability, or catalog contents.
