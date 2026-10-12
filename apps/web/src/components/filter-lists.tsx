import { Globe, MapPin, Tag } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { NavRow } from "@/components/ui/nav-row";
import { FILTER_PREVIEW_LIMIT } from "@/lib/library-filters";
import type { CountryOption, FilterOptions, PlaceOption } from "@/lib/types";
import { formatTagName } from "@/lib/utils";

/**
 * Single-select tag list (sorted by count by the API): the first
 * FILTER_PREVIEW_LIMIT tags plus the selected one, or every tag after "Show all".
 */
export function TagFilterList({
	tags,
	selectedTag,
	onSelect,
}: {
	tags: FilterOptions["tags"];
	selectedTag: string | null;
	onSelect: (tag: string | null) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const preview = showAll ? tags : tags.slice(0, FILTER_PREVIEW_LIMIT);
	// Keep the selection reachable when it is collapsed away or out of scope.
	const visible: { tag: string; count?: number }[] =
		selectedTag !== null && !preview.some((t) => t.tag === selectedTag)
			? [
					...preview,
					tags.find((t) => t.tag === selectedTag) ?? { tag: selectedTag },
				]
			: preview;

	return (
		<div data-testid="tag-filter-list">
			{visible.map(({ tag, count }) => (
				<NavRow
					key={tag}
					icon={<Tag className="h-4 w-4" />}
					label={formatTagName(tag)}
					trailing={count}
					selected={selectedTag === tag}
					aria-pressed={selectedTag === tag}
					onClick={() => onSelect(selectedTag === tag ? null : tag)}
				/>
			))}
			<ShowAllToggle
				total={tags.length}
				showAll={showAll}
				onToggle={() => setShowAll((current) => !current)}
			/>
		</div>
	);
}

/** "Show all (N)" / "Show fewer" toggle below a previewed filter list. */
export function ShowAllToggle({
	total,
	showAll,
	onToggle,
}: {
	total: number;
	showAll: boolean;
	onToggle: () => void;
}) {
	if (total <= FILTER_PREVIEW_LIMIT) return null;
	return (
		<Button
			variant="ghost"
			size="xs"
			onClick={onToggle}
			className="w-full justify-start"
		>
			{showAll ? "Show fewer" : `Show all (${total})`}
		</Button>
	);
}

/**
 * Cities of the selected country (count desc from the API), previewed like
 * tags. Keyed by country by the caller, so "Show all" resets per country.
 */
function CityFilterList({
	cities,
	selectedPlace,
	onSelect,
}: {
	cities: PlaceOption[];
	selectedPlace: number | null;
	onSelect: (place: number | null) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const preview = showAll ? cities : cities.slice(0, FILTER_PREVIEW_LIMIT);
	const visible: { id: number; name: string; count?: number }[] =
		selectedPlace !== null && !preview.some((c) => c.id === selectedPlace)
			? [
					...preview,
					cities.find((c) => c.id === selectedPlace) ?? {
						id: selectedPlace,
						name: "Selected place",
					},
				]
			: preview;

	return (
		<div data-testid="city-filter-list">
			{visible.map(({ id, name, count }) => (
				<NavRow
					key={id}
					icon={<MapPin className="h-4 w-4" />}
					label={name}
					trailing={count}
					selected={selectedPlace === id}
					aria-pressed={selectedPlace === id}
					indent={1}
					onClick={() => onSelect(selectedPlace === id ? null : id)}
				/>
			))}
			<ShowAllToggle
				total={cities.length}
				showAll={showAll}
				onToggle={() => setShowAll((current) => !current)}
			/>
		</div>
	);
}

/**
 * Single-select countries (count desc from the API); the selected country
 * lists its cities beneath it. Choosing a city keeps its country selected;
 * clearing the country also clears the city.
 */
export function PlaceFilterList({
	countries,
	places,
	selectedCountry,
	selectedPlace,
	onChange,
}: {
	countries: CountryOption[];
	places: PlaceOption[];
	selectedCountry: string | null;
	selectedPlace: number | null;
	onChange: (selection: {
		country: string | null;
		place: number | null;
	}) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const preview = showAll
		? countries
		: countries.slice(0, FILTER_PREVIEW_LIMIT);
	// Keep the selection reachable when it is collapsed away or out of scope.
	const visible: { code: string; name: string; count?: number }[] =
		selectedCountry !== null && !preview.some((c) => c.code === selectedCountry)
			? [
					...preview,
					countries.find((c) => c.code === selectedCountry) ?? {
						code: selectedCountry,
						name: selectedCountry,
					},
				]
			: preview;

	return (
		<div data-testid="place-filter-list">
			{visible.map(({ code, name, count }) => (
				<div key={code}>
					<NavRow
						icon={<Globe className="h-4 w-4" />}
						label={name}
						trailing={count}
						selected={selectedCountry === code}
						aria-pressed={selectedCountry === code}
						onClick={() =>
							onChange(
								selectedCountry === code
									? { country: null, place: null }
									: { country: code, place: null },
							)
						}
					/>
					{selectedCountry === code && (
						<CityFilterList
							key={code}
							cities={places.filter((p) => p.countryCode === code)}
							selectedPlace={selectedPlace}
							onSelect={(place) => onChange({ country: code, place })}
						/>
					)}
				</div>
			))}
			<ShowAllToggle
				total={countries.length}
				showAll={showAll}
				onToggle={() => setShowAll((current) => !current)}
			/>
		</div>
	);
}
