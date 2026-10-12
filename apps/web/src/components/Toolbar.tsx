import {
	BarChart3,
	Grid3X3,
	Loader2,
	Map as MapIcon,
	Maximize2,
	Moon,
	PanelLeftClose,
	PanelLeftOpen,
	PanelRightClose,
	PanelRightOpen,
	RefreshCw,
	ScanFace,
	Search,
	Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { TimelineCalendar } from "@/components/TimelineCalendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { SegmentedControl } from "@/components/ui/segmented-control";
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
import type { TimelineGrouping, TimelineSort } from "@/lib/timeline";
import { cn } from "@/lib/utils";

/** Timeline controls; only offered while the library grid is shown. */
export interface ToolbarTimeline {
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

/** Gear stats toggle; only offered while the library grid is shown. */
export interface ToolbarGearStats {
	active: boolean;
	onToggle: () => void;
}

/** Loupe face-box toggle; only offered in the loupe on stills. */
export interface ToolbarFaces {
	shown: boolean;
	onToggle: () => void;
}

interface ToolbarProps {
	// View
	viewMode: ViewMode;
	onViewModeChange: (mode: ViewMode) => void;
	thumbnailSize: number;
	onThumbnailSizeChange: (size: number) => void;
	/** Grouping/sort/calendar controls; null outside the library grid. */
	timeline?: ToolbarTimeline | null;
	/** Gear stats toggle; null outside the library grid. */
	gearStats?: ToolbarGearStats | null;
	/** Face boxes toggle; null outside the loupe on a still. */
	faces?: ToolbarFaces | null;

	// Panels
	leftPanelVisible: boolean;
	rightPanelVisible: boolean;
	onToggleLeftPanel: () => void;
	onToggleRightPanel: () => void;

	// Search
	searchQuery: string;
	onSearchChange: (query: string) => void;
	onSearch: () => void;

	// Actions
	onRefresh: () => void;
	onReprocess: () => void;
	isRefreshing?: boolean;
	/** Upload button and queue; omitted renders neither. */
	uploads?: UploadsApi;

	// Processing indicator
	hasActiveJobs?: boolean;
	processingProgress?: { current: number; total: number };

	// Stats
	photoCount?: number;
	className?: string;
}

export function Toolbar({
	viewMode,
	onViewModeChange,
	thumbnailSize,
	onThumbnailSizeChange,
	timeline = null,
	gearStats = null,
	faces = null,
	leftPanelVisible,
	rightPanelVisible,
	onToggleLeftPanel,
	onToggleRightPanel,
	searchQuery,
	onSearchChange,
	onSearch,
	onRefresh,
	onReprocess,
	isRefreshing,
	uploads,
	hasActiveJobs,
	processingProgress,
	photoCount = 0,
	className,
}: ToolbarProps) {
	const [isDarkMode, setIsDarkMode] = useState(false);
	const [reprocessOpen, setReprocessOpen] = useState(false);
	const scanDisabled = isRefreshing || hasActiveJobs;

	useEffect(() => {
		const isDark = document.documentElement.classList.contains("dark");
		setIsDarkMode(isDark);
	}, []);

	const toggleDarkMode = () => {
		const newMode = !isDarkMode;
		setIsDarkMode(newMode);
		document.documentElement.classList.toggle("dark", newMode);
		localStorage.setItem("theme", newMode ? "dark" : "light");
	};

	const handleSearchKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			onSearch();
		}
	};

	return (
		<TooltipProvider delayDuration={300}>
			<div className={cn("flex h-12 items-center gap-2 px-3", className)}>
				{/* Left panel toggle */}
				<Tooltip>
					<TooltipTrigger asChild>
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
					</TooltipTrigger>
					<TooltipContent>
						{leftPanelVisible ? "Hide left panel" : "Show left panel"}
					</TooltipContent>
				</Tooltip>

				<Separator orientation="vertical" className="h-5" />

				{/* View mode toggle */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() =>
								onViewModeChange(viewMode === "grid" ? "loupe" : "grid")
							}
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

				{/* Map view toggle */}
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

				{/* Thumbnail size slider (only in grid mode) */}
				{viewMode === "grid" && (
					<>
						<Separator orientation="vertical" className="h-5" />
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
					</>
				)}

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
						<TimelineCalendar
							counts={timeline.calendarCounts}
							capturedDate={timeline.capturedDate}
							onSelectDay={timeline.onCapturedDateSelect}
						/>
					</>
				)}

				{/* Spacer */}
				<div className="flex-1" />

				{/* Search */}
				<div className="relative w-72">
					<Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
					<Input
						type="text"
						placeholder="Search photos..."
						value={searchQuery}
						onChange={(e) => onSearchChange(e.target.value)}
						onKeyDown={handleSearchKeyDown}
						className="h-8 pl-8 text-xs"
					/>
				</div>

				{/* Stats */}
				<div className="flex items-center gap-1 whitespace-nowrap text-xs text-subtle tabular-nums">
					<span>{photoCount} photos</span>
				</div>

				<Separator orientation="vertical" className="h-5" />

				{/* Processing indicator */}
				{hasActiveJobs && processingProgress && (
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
						<span>
							{processingProgress.current}/{processingProgress.total}
						</span>
					</div>
				)}

				{uploads && <UploadMenu uploads={uploads} />}

				{/* Refresh */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={onRefresh}
							disabled={scanDisabled}
							aria-label="Scan for new photos"
						>
							<RefreshCw
								className={cn("h-4 w-4", isRefreshing && "animate-spin")}
							/>
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
						<Button
							variant="ghost"
							size="xs"
							disabled={scanDisabled}
						>
							Reprocess all photos…
						</Button>
					</SheetTrigger>
					<SheetContent>
						<SheetHeader>
							<SheetTitle>Reprocess all photos?</SheetTitle>
							<SheetDescription>
								This regenerates thumbnails and embeddings for every photo. Your
								original files are left untouched. This takes longer than a
								normal scan, which only processes new or changed photos and
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

				{/* Theme toggle */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={toggleDarkMode}
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

				<Separator orientation="vertical" className="h-5" />

				{/* Right panel toggle */}
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
		</TooltipProvider>
	);
}
