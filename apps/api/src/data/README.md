# Offline place dataset

`places.tsv.gz` is the offline reverse-geocoding dataset read by `src/services/place-lookup.ts`. The API never calls an external geocoding service.

## Source and license

Contains data from [GeoNames](https://www.geonames.org/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/):

- `cities5000.zip`: populated places with a population of at least 5,000
- `admin1CodesASCII.txt`: first-level administrative division (region) names
- `countryInfo.txt`: country names

All files come from <https://download.geonames.org/export/dump/>. The generator drops sections of populated places (feature code `PPLX`), historical, abandoned, and destroyed places, and numbered districts with a same-named parent within 50 km (for example the Paris arrondissements). It rounds coordinates to 4 decimal places.

## Format

Gzip-compressed UTF-8, one tab-separated record per line:

- `@{ISO2}\t{country name}` lines first, ordered by code
- `{geonameid}\t{name}\t{region or empty}\t{ISO2}\t{latitude}\t{longitude}` lines, ordered by geonameid

## Regenerate

```bash
cd apps/api && bun run build:places
```

Bump `PLACE_DATASET_VERSION` in `src/services/place-lookup.ts` whenever the regenerated file or the matching rule changes; the `place-photos-v1` backfill then recomputes every stored place.
