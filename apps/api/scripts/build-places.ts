/**
 * Builds the committed offline place dataset `src/data/places.tsv.gz` from
 * GeoNames (CC BY 4.0): `cities5000.zip` (populated places with population
 * >= 5,000), `admin1CodesASCII.txt` (region names), and `countryInfo.txt`
 * (country names). Run with `bun run build:places` from apps/api; bump
 * `PLACE_DATASET_VERSION` in `src/services/place-lookup.ts` whenever the
 * output changes so the backfill recomputes stored places.
 *
 * Output: gzip-compressed UTF-8 text, one record per line, tab-separated:
 * - `@{CC}\t{country name}` country lines first, ordered by ISO2 code;
 * - then `{geonameid}\t{name}\t{region}\t{CC}\t{latitude}\t{longitude}` place
 *   lines ordered by geonameid. `name` and `region` are the UTF-8 GeoNames
 *   names (region is the admin1 name, empty when unknown); coordinates are
 *   rounded to 4 decimal places (about 11 m).
 *
 * Rows dropped from `cities5000`:
 * - feature codes PPLX (sections of a populated place, e.g. Shibuya inside
 *   Tokyo), PPLH/PPLCH (historical), PPLQ (abandoned), and PPLW (destroyed);
 * - numbered districts named `{Base} NN...` when a place named `{Base}` in the
 *   same country lies within 50 km (the Paris and Marseille arrondissements),
 *   so photos resolve to the city rather than "Paris 04 Hôtel-de-Ville".
 */
import { inflateRawSync } from "node:zlib";

const SOURCE = "https://download.geonames.org/export/dump";
const OUTPUT = new URL("../src/data/places.tsv.gz", import.meta.url);
const EXCLUDED_FEATURE_CODES: Record<string, true> = {
	PPLX: true,
	PPLH: true,
	PPLCH: true,
	PPLQ: true,
	PPLW: true,
};
const NUMBERED_DISTRICT = /^(.+?) \d{1,2}(?: .*)?$/;
const DISTRICT_PARENT_MAX_KM = 50;

async function download(name: string): Promise<Uint8Array> {
	const response = await fetch(`${SOURCE}/${name}`);
	if (!response.ok) {
		throw new Error(`GET ${name} failed: ${response.status}`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

/** Extracts the single deflated or stored member named `name` from a ZIP archive. */
function unzipMember(archive: Uint8Array, name: string): Uint8Array {
	const view = new DataView(
		archive.buffer,
		archive.byteOffset,
		archive.byteLength,
	);
	let end = archive.length - 22;
	while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
	if (end < 0) throw new Error("ZIP end of central directory not found");
	const entries = view.getUint16(end + 10, true);
	let offset = view.getUint32(end + 16, true);
	for (let entry = 0; entry < entries; entry++) {
		if (view.getUint32(offset, true) !== 0x02014b50) {
			throw new Error("Corrupt ZIP central directory");
		}
		const method = view.getUint16(offset + 10, true);
		const compressedSize = view.getUint32(offset + 20, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const localOffset = view.getUint32(offset + 42, true);
		const entryName = new TextDecoder().decode(
			archive.subarray(offset + 46, offset + 46 + nameLength),
		);
		if (entryName === name) {
			const dataStart =
				localOffset +
				30 +
				view.getUint16(localOffset + 26, true) +
				view.getUint16(localOffset + 28, true);
			const data = archive.subarray(dataStart, dataStart + compressedSize);
			if (method === 0) return data;
			if (method === 8) return inflateRawSync(data);
			throw new Error(`Unsupported ZIP compression method ${method}`);
		}
		offset += 46 + nameLength + extraLength + commentLength;
	}
	throw new Error(`${name} not found in ZIP`);
}

function rows(text: string): string[][] {
	return text
		.split("\n")
		.filter((line) => line !== "" && !line.startsWith("#"))
		.map((line) => line.split("\t"));
}

function haversineKm(
	latitude1: number,
	longitude1: number,
	latitude2: number,
	longitude2: number,
): number {
	const radians = Math.PI / 180;
	const a =
		Math.sin(((latitude2 - latitude1) * radians) / 2) ** 2 +
		Math.cos(latitude1 * radians) *
			Math.cos(latitude2 * radians) *
			Math.sin(((longitude2 - longitude1) * radians) / 2) ** 2;
	return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const [citiesZip, admin1Text, countryText] = await Promise.all([
	download("cities5000.zip"),
	download("admin1CodesASCII.txt").then((bytes) =>
		new TextDecoder().decode(bytes),
	),
	download("countryInfo.txt").then((bytes) => new TextDecoder().decode(bytes)),
]);

const countries = new Map(
	rows(countryText).map((columns) => [columns[0], columns[4]]),
);
const regions = new Map(
	rows(admin1Text).map((columns) => [columns[0], columns[1]]),
);

type Place = {
	id: number;
	name: string;
	region: string;
	countryCode: string;
	latitude: number;
	longitude: number;
};
const candidates: Place[] = [];
for (const columns of rows(
	new TextDecoder().decode(unzipMember(citiesZip, "cities5000.txt")),
)) {
	if (columns[6] !== "P" || EXCLUDED_FEATURE_CODES[columns[7]]) continue;
	const countryCode = columns[8];
	if (!countries.has(countryCode)) {
		throw new Error(`Unknown country code ${countryCode} (${columns[0]})`);
	}
	const latitude = Number(columns[4]);
	const longitude = Number(columns[5]);
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
		throw new Error(`Invalid coordinates for ${columns[0]}`);
	}
	candidates.push({
		id: Number(columns[0]),
		name: columns[1],
		region: regions.get(`${countryCode}.${columns[10]}`) ?? "",
		countryCode,
		latitude: Math.round(latitude * 1e4) / 1e4,
		longitude: Math.round(longitude * 1e4) / 1e4,
	});
}

const byCountryAndName = new Map<string, Place[]>();
for (const place of candidates) {
	const key = `${place.countryCode}\t${place.name}`;
	const group = byCountryAndName.get(key);
	if (group) group.push(place);
	else byCountryAndName.set(key, [place]);
}
const districts: string[] = [];
const places = candidates.filter((place) => {
	const base = NUMBERED_DISTRICT.exec(place.name)?.[1];
	if (!base) return true;
	const parent = byCountryAndName
		.get(`${place.countryCode}\t${base}`)
		?.some(
			(candidate) =>
				haversineKm(
					place.latitude,
					place.longitude,
					candidate.latitude,
					candidate.longitude,
				) <= DISTRICT_PARENT_MAX_KM,
		);
	if (parent) districts.push(place.name);
	return !parent;
});
places.sort((left, right) => left.id - right.id);

const usedCountries = [...new Set(places.map((place) => place.countryCode))]
	.sort()
	.map((code) => `@${code}\t${countries.get(code)}`);
const lines = places.map(
	(place) =>
		`${place.id}\t${place.name}\t${place.region}\t${place.countryCode}\t${place.latitude}\t${place.longitude}`,
);
const text = `${[...usedCountries, ...lines].join("\n")}\n`;
const compressed = Bun.gzipSync(new TextEncoder().encode(text), { level: 9 });
await Bun.write(OUTPUT, compressed);
console.log(
	`Wrote ${OUTPUT.pathname}: ${places.length} places, ${usedCountries.length} countries, ${compressed.length} bytes (dropped ${candidates.length - places.length} numbered districts: ${districts.join(", ")})`,
);
