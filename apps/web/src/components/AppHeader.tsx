import {
	BarChart3,
	CalendarClock,
	CalendarRange,
	Camera,
	CircleDot,
	Flag,
	Globe,
	Grid3X3,
	Image as ImageIcon,
	Maximize2,
	Map as MapIcon,
	MapPin,
	Moon,
	PanelLeftClose,
	PanelLeftOpen,
	PanelRightClose,
	PanelRightOpen,
	RefreshCw,
	ScanFace,
	Star,
	Sun,
	Tag,
	UserRound,
	Zap,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { FilterMenu } from "@/components/FilterMenu";
import { TimelineCalendar } from "@/components/TimelineCalendar";
import { Button } from "@/components/ui/button";
import { RemovableChip } from "@/components/ui/chip";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Separator } from "@/components/ui/separator";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { UploadMenu } from "@/components/UploadMenu";
import type { ViewMode } from "@/hooks/use-library-state";
import type { UploadsApi } from "@/hooks/use-uploads";
import { eventTitle } from "@/lib/events";
import {
	EMPTY_LIBRARY_FILTERS,
	FLAG_FILTER_LABELS,
	type LibraryFilters,
	minRatingLabel,
} from "@/lib/library-filters";
import { formatCapturedDate } from "@/lib/on-this-day";
import type { TimelineGrouping, TimelineSort } from "@/lib/timeline";
import type { EventSummary, FilterOptions } from "@/lib/types";
import { cn, formatMonthLabel, formatTagName } from "@/lib/utils";

/** Timeline controls; only offered while the library grid is shown. */
export interface HeaderTimeline {
	grouping: TimelineGrouping;
	onGroupingChange: (grouping: TimelineGrouping) => void;
	sort: TimelineSort;
	onSortChange: (sort: TimelineSort) => void;
	/** Photos per EXIF capture day in the loaded library. */
	calendarCounts: ReadonlyMap<string, number>;
	capturedDate: string | null;
	onCapturedDateSelect: (capturedDate: string) => void;
}

const GROUPING_OPTIONS: { value: TimelineGrouping; label: string }[] = [
	{ value: "years", label: "Years" },
	{ value: "months", label: "Months" },
	{ value: "all", label: "All" },
];

const SORT_OPTIONS: { value: TimelineSort; label: string }[] = [
	{ value: "captured", label: "Captured" },
	{ value: "added", label: "Added" },
];

export interface Crumb {
	label: string;
	/** Omitted for the current (last) segment. */
	onSelect?: () => void;
}

interface AppHeaderProps {
	crumbs: Crumb[];
	title: string;
	/** "214 photos" and optional scope detail. */
	meta: string;
	/** Opens "Save as Smart Album"; omitted when nothing savable is active. */
	onSaveSmartAlbum?: () => void;

	viewMode: ViewMode;
	onViewModeChange: (mode: ViewMode) => void;
	thumbnailSize: number;
	onThumbnailSizeChange: (size: number) => void;
	timeline?: HeaderTimeline | null;
	gearStats?: { active: boolean; onToggle: () => void } | null;
	faces?: { shown: boolean; onToggle: () => void } | null;

	/** Filters apply to the library, search, and similar; hidden in catalog views. */
	filtersAvailable: boolean;
	filterOptions?: FilterOptions;
	filters: LibraryFilters;
	onFiltersChange: (filters: LibraryFilters) => void;
	onEventClear: () => void;
	personLabel: string | null;

	leftPanelVisible: boolean;
	rightPanelVisible: boolean;
	onToggleLeftPanel: () => void;
	onToggleRightPanel: () => void;

	onRefresh: () => void;
	onReprocess: () => void;
	isRefreshing?: boolean;
	uploads?: UploadsApi;
	hasActiveJobs?: boolean;
	className?: string;
}

function activeFilterChips(
	filters: LibraryFilters,
	options: FilterOptions | undefined,
	personLabel: string | null,
	set: (filters: LibraryFilters) => void,
	clearEvent: () => void,
): {
	key: string;
	testId?: string;
	icon: ReactNode;
	label: string;
	clearLabel: string;
	onClear: () => void;
}[] {
	const icon = "h-3 w-3";
	const chips: ReturnType<typeof activeFilterChips> = [];
	if (filters.filterRaw !== "all") {
		chips.push({
			key: "type",
			icon: <ImageIcon className={icon} />,
			label: { raw: "RAW", standard: "Standard", video: "Video", all: "" }[
				filters.filterRaw
			],
			clearLabel: "Clear type",
			onClear: () => set({ ...filters, filterRaw: "all" }),
		});
	}
	if (filters.minRating !== null) {
		chips.push({
			key: "rating",
			icon: <Star className={icon} />,
			label: minRatingLabel(filters.minRating),
			clearLabel: "Clear rating",
			onClear: () => set({ ...filters, minRating: null }),
		});
	}
	if (filters.flag !== null) {
		chips.push({
			key: "flag",
			icon: <Flag className={icon} />,
			label: FLAG_FILTER_LABELS[filters.flag],
			clearLabel: "Clear flag",
			onClear: () => set({ ...filters, flag: null }),
		});
	}
	if (filters.tag !== null) {
		chips.push({
			key: "tag",
			testId: "tag-chip",
			icon: <Tag className={icon} />,
			label: formatTagName(filters.tag),
			clearLabel: "Clear tag",
			onClear: () => set({ ...filters, tag: null }),
		});
	}
	if (filters.camera !== null) {
		chips.push({
			key: "camera",
			icon: <Camera className={icon} />,
			label: filters.camera,
			clearLabel: "Clear camera",
			onClear: () => set({ ...filters, camera: null }),
		});
	}
	if (filters.lens !== null) {
		chips.push({
			key: "lens",
			icon: <CircleDot className={icon} />,
			label: filters.lens,
			clearLabel: "Clear lens",
			onClear: () => set({ ...filters, lens: null }),
		});
	}
	if (filters.iso !== null) {
		chips.push({
			key: "iso",
			icon: <Zap className={icon} />,
			label: `ISO ${filters.iso}`,
			clearLabel: "Clear ISO",
			onClear: () => set({ ...filters, iso: null }),
		});
	}
	if (filters.dateMonth !== null) {
		chips.push({
			key: "date",
			icon: <CalendarClock className={icon} />,
			label: formatMonthLabel(filters.dateMonth),
			clearLabel: "Clear date",
			onClear: () => set({ ...filters, dateMonth: null }),
		});
	}
	if (filters.country !== null) {
		chips.push({
			key: "country",
			testId: "country-chip",
			icon: <Globe className={icon} />,
			label:
				options?.countries.find((c) => c.code === filters.country)?.name ??
				filters.country,
			clearLabel: "Clear country",
			onClear: () => set({ ...filters, country: null, place: null }),
		});
	}
	if (filters.place !== null) {
		chips.push({
			key: "place",
			testId: "place-chip",
			icon: <MapPin className={icon} />,
			label:
				options?.places.find((p) => p.id === filters.place)?.name ??
				"Selected place",
			clearLabel: "Clear place",
			onClear: () => set({ ...filters, place: null }),
		});
	}
	if (filters.personId !== null) {
		chips.push({
			key: "person",
			testId: "person-chip",
			icon: <UserRound className={icon} />,
			label: personLabel ?? "Person",
			clearLabel: "Clear person",
			onClear: () => set({ ...filters, personId: null }),
		});
	}
	if (filters.capturedDate !== null) {
		chips.push({
			key: "captured",
			testId: "captured-date-chip",
			icon: <CalendarClock className={icon} />,
			label: formatCapturedDate(filters.capturedDate),
			clearLabel: "Clear capture date",
			onClear: () => set({ ...filters, capturedDate: null }),
		});
	}
	if (filters.event !== null) {
		chips.push({
			key: "event",
			testId: "event-chip",
			icon: <CalendarRange className={icon} />,
			label: eventTitle(filters.event as EventSummary),
			clearLabel: "Clear event",
			onClear: clearEvent,
		});
	}
	if (filters.bounds !== null) {
		chips.push({
			key: "bounds",
			testId: "map-area-chip",
			icon: <MapPin className={icon} />,
			label: "Map area",
			clearLabel: "Clear map area",
			onClear: () => set({ ...filters, bounds: null }),
		});
	}
	return chips;
}

/**
 * Chrome above the content: breadcrumbs (scope as a path), the title and
 * count, view and timeline controls, and the filter row (active-filter chips,
 * "+ Filter", zoom, and view switch).
 */
export function AppHeader({
	crumbs,
	title,
	meta,
	onSaveSmartAlbum,
	viewMode,
	onViewModeChange,
	thumbnailSize,
	onThumbnailSizeChange,
	timeline = null,
	gearStats = null,
	faces = null,
	filtersAvailable,
	filterOptions,
	filters,
	onFiltersChange,
	onEventClear,
	personLabel,
	leftPanelVisible,
	rightPanelVisible,
	onToggleLeftPanel,
	onToggleRightPanel,
	onRefresh,
	onReprocess,
	isRefreshing,
	uploads,
	hasActiveJobs,
	className,
}: AppHeaderProps) {
	const [isDarkMode, setIsDarkMode] = useState(false);
	const [reprocessOpen, setReprocessOpen] = useState(false);
	const scanDisabled = isRefreshing || hasActiveJobs;

	useEffect(() => {
		setIsDarkMode(document.documentElement.classList.contains("dark"));
	}, []);

	const toggleDarkMode = () => {
		const next = !isDarkMode;
		setIsDarkMode(next);
		document.documentElement.classList.toggle("dark", next);
		localStorage.setItem("theme", next ? "dark" : "light");
	};

	const chips = filtersAvailable
		? activeFilterChips(
				filters,
				filterOptions,
				personLabel,
				onFiltersChange,
				onEventClear,
			)
		: [];

	return (
		<TooltipProvider delayDuration={300}>
			<header
				data-testid="app-header"
				className={cn("border-b border-border", className)}
			>
				{/* Breadcrumbs */}
				<div className="flex items-center gap-1 px-4 pt-2.5 text-xs text-subtle">
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onToggleLeftPanel}
						aria-label={
							leftPanelVisible ? "Hide left panel" : "Show left panel"
						}
					>
						{leftPanelVisible ? (
							<PanelLeftClose className="h-4 w-4" />
						) : (
							<PanelLeftOpen className="h-4 w-4" />
						)}
					</Button>
					<nav
						aria-label="Breadcrumb"
						className="flex min-w-0 items-center gap-0.5"
					>
						{crumbs.map((crumb, index) => (
							<Fragment key={`${index}-${crumb.label}`}>
								{index > 0 && <span className="px-0.5 opacity-50">/</span>}
								{crumb.onSelect ? (
									<button
										type="button"
										onClick={crumb.onSelect}
										className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
									>
										{crumb.label}
									</button>
								) : (
									<span
										aria-current="page"
										className="truncate px-1.5 py-0.5 text-foreground"
									>
										{crumb.label}
									</span>
								)}
							</Fragment>
						))}
					</nav>
					<div className="flex-1" />
					{onSaveSmartAlbum && (
						<Button
							variant="outline"
							size="xs"
							onClick={onSaveSmartAlbum}
							className="h-6 gap-1 rounded-full"
						>
							Save as Smart Album…
						</Button>
					)}
				</div>

				{/* Title + actions */}
				<div className="flex items-end gap-3 px-4 pb-2 pt-1">
					<div className="min-w-0">
						<h1 className="truncate text-2xl font-bold leading-tight tracking-tight">
							{title}
						</h1>
						<div className="text-xs text-subtle tabular-nums">{meta}</div>
					</div>
					<div className="flex-1" />
					{timeline && (
						<>
							<SegmentedControl
								size="sm"
								label="Group by"
								options={GROUPING_OPTIONS}
								value={timeline.grouping}
								onChange={timeline.onGroupingChange}
							/>
							<SegmentedControl
								size="sm"
								label="Sort by"
								options={SORT_OPTIONS}
								value={timeline.sort}
								onChange={timeline.onSortChange}
							/>
						</>
					)}
					{uploads && <UploadMenu uploads={uploads} />}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								size="sm"
								onClick={onRefresh}
								disabled={scanDisabled}
								aria-label="Scan for new photos"
							>
								<RefreshCw
									className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
								/>
								Scan
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{hasActiveJobs
								? "Processing in progress..."
								: "Scan for new photos"}
						</TooltipContent>
					</Tooltip>
					<Sheet open={reprocessOpen} onOpenChange={setReprocessOpen}>
						<SheetTrigger asChild>
							<Button variant="ghost" size="xs" disabled={scanDisabled}>
								Reprocess all photos…
							</Button>
						</SheetTrigger>
						<SheetContent>
							<SheetHeader>
								<SheetTitle>Reprocess all photos?</SheetTitle>
								<SheetDescription>
									This regenerates thumbnails and embeddings for every photo.
									Your original files are left untouched. This takes longer than
									a normal scan, which only processes new or changed photos and
									repairs incomplete processing.
								</SheetDescription>
							</SheetHeader>
							<SheetFooter className="mt-6 gap-2">
								<SheetClose asChild>
									<Button variant="outline">Cancel</Button>
								</SheetClose>
								<Button
									disabled={scanDisabled}
									onClick={() => {
										if (scanDisabled) return;
										setReprocessOpen(false);
										onReprocess();
									}}
								>
									Reprocess all photos
								</Button>
							</SheetFooter>
						</SheetContent>
					</Sheet>
					<Separator orientation="vertical" className="h-5" />
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								onClick={toggleDarkMode}
								aria-label={isDarkMode ? "Light mode" : "Dark mode"}
							>
								{isDarkMode ? (
									<Sun className="h-4 w-4" />
								) : (
									<Moon className="h-4 w-4" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{isDarkMode ? "Light mode" : "Dark mode"}
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								onClick={onToggleRightPanel}
								aria-label={
									rightPanelVisible ? "Hide right panel" : "Show right panel"
								}
							>
								{rightPanelVisible ? (
									<PanelRightClose className="h-4 w-4" />
								) : (
									<PanelRightOpen className="h-4 w-4" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{rightPanelVisible ? "Hide right panel" : "Show right panel"}
						</TooltipContent>
					</Tooltip>
				</div>

				{/* Filter row */}
				<div className="flex flex-wrap items-center gap-1.5 px-4 pb-2.5">
					{filtersAvailable && (
						<>
							{chips.map(
								({ key, testId, icon, label, clearLabel, onClear }) => (
									<RemovableChip
										key={key}
										data-testid={testId}
										icon={icon}
										clearLabel={clearLabel}
										onClear={onClear}
									>
										{label}
									</RemovableChip>
								),
							)}
							<FilterMenu
								filterOptions={filterOptions}
								filters={filters}
								onChange={onFiltersChange}
							/>
							{chips.length > 0 && (
								<Button
									variant="ghost"
									size="xs"
									className="text-subtle"
									onClick={() => onFiltersChange(EMPTY_LIBRARY_FILTERS)}
								>
									Clear all
								</Button>
							)}
						</>
					)}
					<div className="flex-1" />
					{viewMode === "grid" && (
						<div className="flex items-center gap-2">
							<Grid3X3 className="h-3 w-3 text-subtle" />
							<Slider
								value={[thumbnailSize]}
								onValueChange={([v]) => onThumbnailSizeChange(v)}
								min={100}
								max={400}
								step={25}
								className="w-24"
							/>
						</div>
					)}
					{timeline && (
						<TimelineCalendar
							counts={timeline.calendarCounts}
							capturedDate={timeline.capturedDate}
							onSelectDay={timeline.onCapturedDateSelect}
						/>
					)}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								onClick={() =>
									onViewModeChange(viewMode === "grid" ? "loupe" : "grid")
								}
								aria-label={viewMode === "grid" ? "Loupe view" : "Grid view"}
							>
								{viewMode === "grid" ? (
									<Maximize2 className="h-4 w-4" />
								) : (
									<Grid3X3 className="h-4 w-4" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{viewMode === "grid" ? "Loupe view (E)" : "Grid view (G)"}
						</TooltipContent>
					</Tooltip>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Map view"
								aria-pressed={viewMode === "map"}
								onClick={() =>
									onViewModeChange(viewMode === "map" ? "grid" : "map")
								}
							>
								<MapIcon className="h-4 w-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{viewMode === "map" ? "Grid view (G)" : "Map view (M)"}
						</TooltipContent>
					</Tooltip>
					{gearStats && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Gear stats"
									aria-pressed={gearStats.active}
									onClick={gearStats.onToggle}
								>
									<BarChart3 className="h-4 w-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{gearStats.active ? "Back to grid" : "Gear stats"}
							</TooltipContent>
						</Tooltip>
					)}
					{faces && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Face boxes"
									aria-pressed={faces.shown}
									onClick={faces.onToggle}
								>
									<ScanFace className="h-4 w-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{faces.shown ? "Hide face boxes (F)" : "Show face boxes (F)"}
							</TooltipContent>
						</Tooltip>
					)}
				</div>
			</header>
		</TooltipProvider>
	);
}
