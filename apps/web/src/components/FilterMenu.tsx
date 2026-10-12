import {
	Calendar,
	Camera,
	CircleDot,
	Flag,
	Globe,
	Image as ImageIcon,
	Plus,
	Star,
	Tag,
	Zap,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { PlaceFilterList, TagFilterList } from "@/components/filter-lists";
import { Button } from "@/components/ui/button";
import { NavRow } from "@/components/ui/nav-row";
import { Popover } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useDismiss } from "@/hooks/use-dismiss";
import {
	FLAG_FILTER_OPTIONS,
	type LibraryFilters,
	RAW_FILTER_OPTIONS,
	RATING_FILTER_OPTIONS,
} from "@/lib/library-filters";
import type { FilterOptions } from "@/lib/types";
import { cn, formatMonthLabel } from "@/lib/utils";

type Category =
	| "type"
	| "rating"
	| "flag"
	| "tags"
	| "places"
	| "camera"
	| "lens"
	| "iso"
	| "date";

interface FilterMenuProps {
	filterOptions?: FilterOptions;
	filters: LibraryFilters;
	onChange: (filters: LibraryFilters) => void;
}

/**
 * "+ Filter" popover: categories on the left, the selected category's values
 * (with counts) on the right. Every choice sets the same `LibraryFilters`
 * field the old sidebar accordion did.
 */
export function FilterMenu({
	filterOptions,
	filters,
	onChange,
}: FilterMenuProps) {
	const [open, setOpen] = useState(false);
	const [category, setCategory] = useState<Category>("type");
	const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));

	const categories: {
		id: Category;
		label: string;
		icon: ReactNode;
		count?: number;
		show: boolean;
	}[] = [
		{
			id: "type",
			label: "Type",
			icon: <ImageIcon className="h-4 w-4" />,
			show: true,
		},
		{
			id: "rating",
			label: "Rating",
			icon: <Star className="h-4 w-4" />,
			show: true,
		},
		{
			id: "flag",
			label: "Flag",
			icon: <Flag className="h-4 w-4" />,
			show: true,
		},
		{
			id: "tags",
			label: "Tags",
			icon: <Tag className="h-4 w-4" />,
			count: filterOptions?.tags.length,
			show: (filterOptions?.tags.length ?? 0) > 0 || filters.tag !== null,
		},
		{
			id: "places",
			label: "Places",
			icon: <Globe className="h-4 w-4" />,
			count: filterOptions?.countries.length,
			show:
				(filterOptions?.countries.length ?? 0) > 0 ||
				filters.country !== null ||
				filters.place !== null,
		},
		{
			id: "camera",
			label: "Camera",
			icon: <Camera className="h-4 w-4" />,
			count: filterOptions?.cameras.length,
			show: (filterOptions?.cameras.length ?? 0) > 0,
		},
		{
			id: "lens",
			label: "Lens",
			icon: <CircleDot className="h-4 w-4" />,
			count: filterOptions?.lenses.length,
			show: (filterOptions?.lenses.length ?? 0) > 0,
		},
		{
			id: "iso",
			label: "ISO",
			icon: <Zap className="h-4 w-4" />,
			count: filterOptions?.isos.length,
			show: (filterOptions?.isos.length ?? 0) > 0,
		},
		{
			id: "date",
			label: "Date",
			icon: <Calendar className="h-4 w-4" />,
			count: filterOptions?.dates.length,
			show: (filterOptions?.dates.length ?? 0) > 0,
		},
	];

	const optionList = <T extends string | number>(
		values: T[] | undefined,
		selected: T | null,
		label: (value: T) => string,
		icon: ReactNode,
		set: (value: T | null) => void,
	) =>
		(values ?? []).map((value) => (
			<NavRow
				key={String(value)}
				icon={icon}
				label={label(value)}
				selected={selected === value}
				aria-pressed={selected === value}
				onClick={() => set(selected === value ? null : value)}
			/>
		));

	let values: ReactNode = null;
	switch (category) {
		case "type":
			values = (
				<SegmentedControl
					fill
					label="Photo type"
					options={RAW_FILTER_OPTIONS}
					value={filters.filterRaw}
					onChange={(filterRaw) => onChange({ ...filters, filterRaw })}
				/>
			);
			break;
		case "rating":
			values = (
				<SegmentedControl
					fill
					label="Minimum rating"
					options={RATING_FILTER_OPTIONS}
					value={filters.minRating}
					onChange={(minRating) => onChange({ ...filters, minRating })}
				/>
			);
			break;
		case "flag":
			values = (
				<SegmentedControl
					fill
					label="Flag"
					options={FLAG_FILTER_OPTIONS}
					value={filters.flag}
					onChange={(flag) => onChange({ ...filters, flag })}
				/>
			);
			break;
		case "tags":
			values = (
				<TagFilterList
					tags={filterOptions?.tags ?? []}
					selectedTag={filters.tag}
					onSelect={(tag) => onChange({ ...filters, tag })}
				/>
			);
			break;
		case "places":
			values = (
				<PlaceFilterList
					countries={filterOptions?.countries ?? []}
					places={filterOptions?.places ?? []}
					selectedCountry={filters.country}
					selectedPlace={filters.place}
					onChange={(selection) => onChange({ ...filters, ...selection })}
				/>
			);
			break;
		case "camera":
			values = optionList(
				filterOptions?.cameras,
				filters.camera,
				(cam) => cam,
				<Camera className="h-4 w-4" />,
				(camera) => onChange({ ...filters, camera }),
			);
			break;
		case "lens":
			values = optionList(
				filterOptions?.lenses,
				filters.lens,
				(lens) => lens,
				<CircleDot className="h-4 w-4" />,
				(lens) => onChange({ ...filters, lens }),
			);
			break;
		case "iso":
			values = optionList(
				filterOptions?.isos,
				filters.iso,
				(iso) => `ISO ${iso}`,
				<Zap className="h-4 w-4" />,
				(iso) => onChange({ ...filters, iso }),
			);
			break;
		case "date":
			values = optionList(
				filterOptions?.dates,
				filters.dateMonth,
				formatMonthLabel,
				<Calendar className="h-4 w-4" />,
				(dateMonth) => onChange({ ...filters, dateMonth }),
			);
			break;
	}

	return (
		<div ref={ref} className="relative">
			<Button
				variant="outline"
				size="xs"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((current) => !current)}
				className={cn(
					"h-7 gap-1 rounded-full border-dashed px-2.5",
					open && "border-primary text-primary",
				)}
			>
				<Plus className="h-3.5 w-3.5" />
				Filter
			</Button>
			{open && (
				<Popover
					role="dialog"
					aria-label="Filters"
					align="start"
					padding="panel"
					className="flex w-[30rem] max-w-[calc(100vw-2rem)] gap-2 p-0"
				>
					<div className="w-40 shrink-0 border-r border-border p-1.5">
						<div className="px-2 pb-1 pt-1.5 text-xs font-semibold text-subtle">
							Filter by
						</div>
						{categories
							.filter((c) => c.show)
							.map((c) => (
								<NavRow
									key={c.id}
									icon={c.icon}
									label={c.label}
									trailing={c.count}
									selected={category === c.id}
									aria-current={category === c.id ? "true" : undefined}
									onClick={() => setCategory(c.id)}
								/>
							))}
					</div>
					<div className="max-h-80 min-w-0 flex-1 overflow-auto p-1.5">
						{values}
					</div>
				</Popover>
			)}
		</div>
	);
}
