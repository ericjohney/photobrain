import {
	Calendar,
	Camera,
	ChevronRight,
	Clock,
	Folder,
	FolderOpen,
	Images,
	Plus,
	Star,
	Tag,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Collection, FilterOptions, FlagFilter } from "@/lib/types";
import { cn, formatMonthLabel, formatTagName } from "@/lib/utils";
import { CollectionList } from "./CollectionList";

interface FolderNode {
	name: string;
	path: string;
	photoCount: number;
	children: FolderNode[];
}

export type RawFilter = "all" | "raw" | "standard";

export interface LibraryFilters {
	filterRaw: RawFilter;
	camera: string | null;
	lens: string | null;
	iso: number | null;
	dateMonth: string | null;
	/** Minimum star rating (1-5); null matches any rating. */
	minRating: number | null;
	flag: FlagFilter | null;
	/** Tag slug; null matches any tag. */
	tag: string | null;
}

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = {
	filterRaw: "all",
	camera: null,
	lens: null,
	iso: null,
	dateMonth: null,
	minRating: null,
	flag: null,
	tag: null,
};

/** Tags listed before "Show all" expands the full list. */
const TAG_PREVIEW_LIMIT = 12;

const RAW_FILTER_OPTIONS: { value: RawFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "raw", label: "RAW" },
	{ value: "standard", label: "Standard" },
];

/** Compact label for a minimum-rating filter: ★5 or ★n+. */
export function minRatingLabel(minRating: number) {
	return minRating === 5 ? "★5" : `★${minRating}+`;
}

const RATING_FILTER_OPTIONS: { value: number | null; label: string }[] = [
	{ value: null, label: "Any" },
	...[1, 2, 3, 4, 5].map((value) => ({ value, label: minRatingLabel(value) })),
];

export const FLAG_FILTER_LABELS: Record<FlagFilter, string> = {
	pick: "Picks",
	reject: "Rejected",
	unflagged: "Unflagged",
};

const FLAG_FILTER_OPTIONS: { value: FlagFilter | null; label: string }[] = [
	{ value: null, label: "Any" },
	{ value: "pick", label: FLAG_FILTER_LABELS.pick },
	{ value: "reject", label: FLAG_FILTER_LABELS.reject },
	{ value: "unflagged", label: FLAG_FILTER_LABELS.unflagged },
];

/** Single-choice segmented control (one radio per option). */
function SegmentedFilter<T>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: { value: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="mx-2 mb-1 flex rounded bg-secondary p-0.5"
		>
			{options.map((option) => {
				const checked = option.value === value;
				return (
					<button
						key={option.label}
						type="button"
						role="radio"
						aria-checked={checked}
						onClick={() => onChange(option.value)}
						className={cn(
							"flex-auto whitespace-nowrap rounded px-1.5 py-0.5 text-xs transition-colors",
							checked
								? "bg-primary text-primary-foreground"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

interface LibraryPanelProps {
	photoCount: number;
	folders?: FolderNode[];
	selectedFolder: string | null;
	/** Selects a folder (clearing any collection), or null for All Photos. */
	onFolderSelect: (folder: string | null) => void;
	collections: Collection[] | undefined;
	selectedCollectionId: number | null;
	/** Selects a collection (clearing any folder), or null for All Photos. */
	onCollectionSelect: (collectionId: number | null) => void;
	onCreateCollection: (name: string) => Promise<unknown>;
	onRenameCollection: (collectionId: number, name: string) => Promise<unknown>;
	onDeleteCollection: (collectionId: number) => Promise<unknown>;
	filterOptions?: FilterOptions;
	activeFilters: LibraryFilters;
	onFilterChange: (filters: LibraryFilters) => void;
}

interface NavItemProps {
	icon: React.ReactNode;
	label: string;
	count?: number;
	active?: boolean;
	/** Exposes `active` as a toggle state (aria-pressed) for toggle-style items. */
	toggle?: boolean;
	onClick?: () => void;
	indent?: number;
}

function NavItem({
	icon,
	label,
	count,
	active,
	toggle,
	onClick,
	indent = 0,
}: NavItemProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={toggle ? Boolean(active) : undefined}
			className={cn(
				"flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
				"hover:bg-secondary/50",
				active && "bg-primary/10 text-primary",
			)}
			style={{ paddingLeft: `${8 + indent * 16}px` }}
		>
			<span className="flex-shrink-0 text-muted-foreground">{icon}</span>
			<span className="flex-1 truncate">{label}</span>
			{count !== undefined && (
				<span className="text-xs text-muted-foreground">{count}</span>
			)}
		</button>
	);
}

interface SectionProps {
	title: string;
	children: React.ReactNode;
	defaultOpen?: boolean;
	/** Controlled open state; omit for an uncontrolled section. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** Header controls rendered beside the title (e.g. a "+" button). */
	actions?: ReactNode;
}

function Section({
	title,
	children,
	defaultOpen = true,
	open: controlledOpen,
	onOpenChange,
	actions,
}: SectionProps) {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
	const open = controlledOpen ?? uncontrolledOpen;
	const setOpen = onOpenChange ?? setUncontrolledOpen;

	return (
		<div className="mb-1">
			<div className="flex items-center">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					className="flex flex-1 items-center gap-1 px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
				>
					<ChevronRight
						className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
					/>
					{title}
				</button>
				{actions}
			</div>
			{open && <div className="mt-0.5">{children}</div>}
		</div>
	);
}

/**
 * Single-select tag list (sorted by count by the API): the first
 * TAG_PREVIEW_LIMIT tags plus the selected one, or every tag after "Show all".
 */
function TagFilterList({
	tags,
	selectedTag,
	onSelect,
}: {
	tags: FilterOptions["tags"];
	selectedTag: string | null;
	onSelect: (tag: string | null) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const preview = showAll ? tags : tags.slice(0, TAG_PREVIEW_LIMIT);
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
				<NavItem
					key={tag}
					icon={<Tag className="h-4 w-4" />}
					label={formatTagName(tag)}
					count={count}
					active={selectedTag === tag}
					toggle
					onClick={() => onSelect(selectedTag === tag ? null : tag)}
				/>
			))}
			{tags.length > TAG_PREVIEW_LIMIT && (
				<button
					type="button"
					onClick={() => setShowAll((current) => !current)}
					className="w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
				>
					{showAll ? "Show fewer" : `Show all (${tags.length})`}
				</button>
			)}
		</div>
	);
}

interface FolderItemProps {
	folder: FolderNode;
	depth: number;
	selectedFolder: string | null;
	expandedFolders: Set<string>;
	onToggleExpand: (path: string) => void;
	onSelect: (path: string) => void;
}

function FolderItem({
	folder,
	depth,
	selectedFolder,
	expandedFolders,
	onToggleExpand,
	onSelect,
}: FolderItemProps) {
	const hasChildren = folder.children.length > 0;
	const isExpanded = expandedFolders.has(folder.path);
	const isSelected = selectedFolder === folder.path;

	return (
		<div>
			<button
				type="button"
				onClick={() => onSelect(folder.path)}
				className={cn(
					"flex w-full items-center gap-1 rounded px-2 py-1.5 text-left text-sm transition-colors",
					"hover:bg-secondary/50",
					isSelected && "bg-primary/10 text-primary",
				)}
				style={{ paddingLeft: `${8 + depth * 16}px` }}
			>
				{hasChildren ? (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onToggleExpand(folder.path);
						}}
						className="flex-shrink-0 p-0.5 -ml-1 hover:bg-secondary rounded"
					>
						<ChevronRight
							className={cn(
								"h-3 w-3 transition-transform text-muted-foreground",
								isExpanded && "rotate-90",
							)}
						/>
					</button>
				) : (
					<span className="w-4" />
				)}
				<span className="flex-shrink-0 text-muted-foreground">
					{isSelected || isExpanded ? (
						<FolderOpen className="h-4 w-4" />
					) : (
						<Folder className="h-4 w-4" />
					)}
				</span>
				<span className="flex-1 truncate">{folder.name}</span>
				<span className="text-xs text-muted-foreground">
					{folder.photoCount}
				</span>
			</button>

			{hasChildren && isExpanded && (
				<div>
					{folder.children.map((child) => (
						<FolderItem
							key={child.path}
							folder={child}
							depth={depth + 1}
							selectedFolder={selectedFolder}
							expandedFolders={expandedFolders}
							onToggleExpand={onToggleExpand}
							onSelect={onSelect}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function LibraryPanel({
	photoCount,
	folders = [],
	selectedFolder,
	onFolderSelect,
	collections,
	selectedCollectionId,
	onCollectionSelect,
	onCreateCollection,
	onRenameCollection,
	onDeleteCollection,
	filterOptions,
	activeFilters,
	onFilterChange,
}: LibraryPanelProps) {
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
		new Set(),
	);
	const [collectionsOpen, setCollectionsOpen] = useState(true);
	const [creatingCollection, setCreatingCollection] = useState(false);

	const handleToggleExpand = (path: string) => {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	};

	const handleFolderSelect = (path: string) => {
		// Toggle selection - clicking same folder again shows all photos
		onFolderSelect(selectedFolder === path ? null : path);
	};

	return (
		<ScrollArea className="h-full">
			<div className="p-2">
				{/* Catalog Section */}
				<Section title="Catalog">
					<NavItem
						icon={<Images className="h-4 w-4" />}
						label="All Photos"
						count={photoCount}
						active={selectedFolder === null && selectedCollectionId === null}
						onClick={() => onFolderSelect(null)}
					/>
					<NavItem
						icon={<Clock className="h-4 w-4" />}
						label="Recent Imports"
						count={0}
					/>
					<NavItem
						icon={<Star className="h-4 w-4" />}
						label="Quick Collection"
						count={0}
					/>
				</Section>

				{/* Folders Section */}
				<Section title="Folders">
					{folders.length === 0 ? (
						<div className="px-2 py-4 text-xs text-muted-foreground text-center">
							No folders found
						</div>
					) : (
						folders.map((folder) => (
							<FolderItem
								key={folder.path}
								folder={folder}
								depth={0}
								selectedFolder={selectedFolder}
								expandedFolders={expandedFolders}
								onToggleExpand={handleToggleExpand}
								onSelect={handleFolderSelect}
							/>
						))
					)}
				</Section>

				{/* Collections Section */}
				<Section
					title="Collections"
					open={collectionsOpen}
					onOpenChange={setCollectionsOpen}
					actions={
						<button
							type="button"
							aria-label="New collection"
							title="New collection"
							onClick={() => {
								setCollectionsOpen(true);
								setCreatingCollection(true);
							}}
							className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
						>
							<Plus className="h-3.5 w-3.5" />
						</button>
					}
				>
					<CollectionList
						collections={collections}
						selectedCollectionId={selectedCollectionId}
						onSelect={(id) =>
							// Re-selecting the active collection returns to All Photos.
							onCollectionSelect(selectedCollectionId === id ? null : id)
						}
						creating={creatingCollection}
						onCreatingChange={setCreatingCollection}
						onCreate={onCreateCollection}
						onRename={onRenameCollection}
						onDelete={onDeleteCollection}
					/>
				</Section>

				{/* Filter By Section — also scopes an active search */}
				<Section title="Filter By" defaultOpen={false}>
					<Section title="Type">
						<SegmentedFilter
							label="Photo type"
							options={RAW_FILTER_OPTIONS}
							value={activeFilters.filterRaw}
							onChange={(filterRaw) =>
								onFilterChange({ ...activeFilters, filterRaw })
							}
						/>
					</Section>
					<Section title="Rating">
						<SegmentedFilter
							label="Minimum rating"
							options={RATING_FILTER_OPTIONS}
							value={activeFilters.minRating}
							onChange={(minRating) =>
								onFilterChange({ ...activeFilters, minRating })
							}
						/>
					</Section>
					<Section title="Flag">
						<SegmentedFilter
							label="Flag"
							options={FLAG_FILTER_OPTIONS}
							value={activeFilters.flag}
							onChange={(flag) => onFilterChange({ ...activeFilters, flag })}
						/>
					</Section>
					{((filterOptions?.tags && filterOptions.tags.length > 0) ||
						activeFilters.tag !== null) && (
						<Section title="Tags">
							<TagFilterList
								tags={filterOptions?.tags ?? []}
								selectedTag={activeFilters.tag}
								onSelect={(tag) => onFilterChange({ ...activeFilters, tag })}
							/>
						</Section>
					)}
					{filterOptions?.cameras && filterOptions.cameras.length > 0 && (
						<Section title="Camera" defaultOpen={false}>
							{filterOptions.cameras.map((cam) => (
								<NavItem
									key={cam}
									icon={<Camera className="h-4 w-4" />}
									label={cam}
									active={activeFilters.camera === cam}
									onClick={() =>
										onFilterChange({
											...activeFilters,
											camera: activeFilters.camera === cam ? null : cam,
										})
									}
								/>
							))}
						</Section>
					)}
					{filterOptions?.lenses && filterOptions.lenses.length > 0 && (
						<Section title="Lens" defaultOpen={false}>
							{filterOptions.lenses.map((lens) => (
								<NavItem
									key={lens}
									icon={<ChevronRight className="h-4 w-4" />}
									label={lens}
									active={activeFilters.lens === lens}
									onClick={() =>
										onFilterChange({
											...activeFilters,
											lens: activeFilters.lens === lens ? null : lens,
										})
									}
								/>
							))}
						</Section>
					)}
					{filterOptions?.isos && filterOptions.isos.length > 0 && (
						<Section title="ISO" defaultOpen={false}>
							{filterOptions.isos.map((iso) => (
								<NavItem
									key={iso}
									icon={<ChevronRight className="h-4 w-4" />}
									label={`ISO ${iso}`}
									active={activeFilters.iso === iso}
									onClick={() =>
										onFilterChange({
											...activeFilters,
											iso: activeFilters.iso === iso ? null : iso,
										})
									}
								/>
							))}
						</Section>
					)}
					{filterOptions?.dates && filterOptions.dates.length > 0 && (
						<Section title="Date" defaultOpen={false}>
							{filterOptions.dates.map((d) => (
								<NavItem
									key={d}
									icon={<Calendar className="h-4 w-4" />}
									label={formatMonthLabel(d)}
									active={activeFilters.dateMonth === d}
									onClick={() =>
										onFilterChange({
											...activeFilters,
											dateMonth: activeFilters.dateMonth === d ? null : d,
										})
									}
								/>
							))}
						</Section>
					)}
				</Section>

				{/* Active filters indicator */}
				{(activeFilters.filterRaw !== "all" ||
					activeFilters.camera ||
					activeFilters.lens ||
					activeFilters.iso ||
					activeFilters.dateMonth ||
					activeFilters.minRating !== null ||
					activeFilters.flag !== null ||
					activeFilters.tag !== null) && (
					<div className="mt-4 rounded bg-primary/10 px-2 py-1.5 text-xs text-primary flex items-center justify-between">
						<span>Filters active</span>
						<button
							type="button"
							className="underline cursor-pointer"
							onClick={() => onFilterChange(EMPTY_LIBRARY_FILTERS)}
						>
							Clear all
						</button>
					</div>
				)}

				{/* Selected folder indicator */}
				{selectedFolder && (
					<div className="mt-4 rounded bg-secondary px-2 py-1.5 text-xs text-muted-foreground">
						Showing: {selectedFolder}
					</div>
				)}
			</div>
		</ScrollArea>
	);
}
