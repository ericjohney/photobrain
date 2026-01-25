import {
	Grid3X3,
	Loader2,
	Maximize2,
	Moon,
	PanelLeftClose,
	PanelLeftOpen,
	PanelRightClose,
	PanelRightOpen,
	RefreshCw,
	Search,
	Sun,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ViewMode } from "@/hooks/use-library-state";
import { cn } from "@/lib/utils";

interface ToolbarProps {
	// View
	viewMode: ViewMode;
	onViewModeChange: (mode: ViewMode) => void;
	thumbnailSize: number;
	onThumbnailSizeChange: (size: number) => void;

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
	isRefreshing?: boolean;

	// Processing indicator
	hasActiveJobs?: boolean;
	processingProgress?: { current: number; total: number };

	// Stats
	photoCount?: number;
	selectedCount?: number;

	className?: string;
}

export function Toolbar({
	viewMode,
	onViewModeChange,
	thumbnailSize,
	onThumbnailSizeChange,
	leftPanelVisible,
	rightPanelVisible,
	onToggleLeftPanel,
	onToggleRightPanel,
	searchQuery,
	onSearchChange,
	onSearch,
	onRefresh,
	isRefreshing,
	hasActiveJobs,
	processingProgress,
	photoCount = 0,
	selectedCount = 0,
	className,
}: ToolbarProps) {
	const [isDarkMode, setIsDarkMode] = useState(false);

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
			<div className={cn("flex h-10 items-center gap-2 px-2", className)}>
				{/* Left panel toggle */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7"
							onClick={onToggleLeftPanel}
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
							size="icon"
							className="h-7 w-7"
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

				{/* Thumbnail size slider (only in grid mode) */}
				{viewMode === "grid" && (
					<>
						<Separator orientation="vertical" className="h-5" />
						<div className="flex items-center gap-2">
							<Grid3X3 className="h-3 w-3 text-muted-foreground" />
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

				{/* Spacer */}
				<div className="flex-1" />

				{/* Search */}
				<div className="relative w-64">
					<Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						type="text"
						placeholder="Search photos..."
						value={searchQuery}
						onChange={(e) => onSearchChange(e.target.value)}
						onKeyDown={handleSearchKeyDown}
						className="h-7 pl-7 text-xs"
					/>
				</div>

				{/* Stats */}
				<div className="flex items-center gap-1 text-2xs text-muted-foreground">
					{selectedCount > 0 ? (
						<span>
							{selectedCount} of {photoCount} selected
						</span>
					) : (
						<span>{photoCount} photos</span>
					)}
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

				{/* Refresh */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7"
							onClick={onRefresh}
							disabled={isRefreshing || hasActiveJobs}
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

				{/* Theme toggle */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="h-7 w-7"
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
							size="icon"
							className="h-7 w-7"
							onClick={onToggleRightPanel}
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
