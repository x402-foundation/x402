# Bazaar Extension

... (conteúdo existente) ...

## Catalog Entry Schema

A catalog entry represents a service or resource available for discovery. To ensure data integrity and prevent metric inflation, entries must distinguish between discovery via verification and discovery via settlement.

### Fields

- `id`: Unique identifier for the entry.
- `resource_uri`: The URI of the resource.
- `provenance`: The origin of the catalog entry.
    - `settled`: The entry was created/updated via a successful settlement (payment occurred).
    - `verified`: The entry was created/updated via a successful verification (payload validated, no payment).
- `metrics`:
    - `l30DaysTotalCalls`: Total number of interactions (both verify and settle).
    - `l30DaysVerifiedCalls`: Number of interactions that were only verified.
    - `l30DaysSettledCalls`: Number of interactions that resulted in a settlement.
    - `l30DaysUniquePayers`: Number of unique payers who successfully settled.

... (restante do documento) ...
