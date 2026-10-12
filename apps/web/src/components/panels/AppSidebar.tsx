import {
	ChevronRight,
	Copy,
	Folder,
	FolderOpen,
	Images,
	Plus,
	PanelLeftClose,
	PanelLeftOpen,
	ScanEye,
	Search,
	Users,
} from "lucide-react";
import { forwardRef, type ReactNode, useState } from "react";
import { ShowAllToggle } from "@/components/filter-lists";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NavRow, navRowClasses } from "@/components/ui/nav-row";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { eventSubtitle, eventTitle } from "@/lib/events";
import { FILTER_PREVIEW_LIMIT } from "@/lib/library-filters";
import { getThumbnailUrl } from "@/lib/thumbnails";
import type { Collection, EventSummary, SmartAlbum } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CollectionList } from "./CollectionList";
import { SmartAlbumList } from "./SmartAlbumList";

export interface FolderNode {
	name: string;
	path: string;
	photoCount: number;
	children: FolderNode[];
}

interface AppSidebarProps {
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
	smartAlbums: SmartAlbum[] | undefined;
	/** The album last applied, until any filter/scope changes; null otherwise. */
	selectedSmartAlbumId: number | null;
	onSmartAlbumSelect: (album: SmartAlbum) => void;
	onRenameSmartAlbum: (albumId: number, name: string) => Promise<unknown>;
	onDeleteSmartAlbum: (albumId: number) => Promise<unknown>;
	/** Auto events in the folder scope, newest first; undefined until loaded. */
	events: EventSummary[] | undefined;
	selectedEvent: EventSummary | null;
	/** Applies an event as the `event` filter, or null to clear it. */
	onEventSelect: (event: EventSummary | null) => void;
	/** Junk review candidates; undefined until loaded. */
	reviewCount: number | undefined;
	reviewActive: boolean;
	onReviewSelect: () => void;
	/** Duplicate plus burst groups; undefined until loaded. */
	duplicateCount: number | undefined;
	duplicatesActive: boolean;
	onDuplicatesSelect: () => void;
	/** Visible (not hidden) people; undefined until loaded. */
	peopleCount: number | undefined;
	peopleActive: boolean;
	onPeopleSelect: () => void;
	searchQuery: string;
	onSearchChange: (query: string) => void;
	/** Icon rail instead of the full sidebar. */
	collapsed: boolean;
	onToggleCollapsed: () => void;
	/** Scan progress card; shown only while expanded. */
	activity?: ReactNode;
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
		<NavRow
			onClick={onClick}
			aria-pressed={toggle ? Boolean(active) : undefined}
			selected={active}
			indent={indent}
			icon={icon}
			label={label}
			trailing={count}
		/>
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
					className="flex flex-1 items-center gap-1 px-2 pb-1 pt-2 text-xs font-semibold text-subtle hover:text-foreground"
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
 * Auto events (newest first from the API) with their cover, title, and
 * subtitle: the first FILTER_PREVIEW_LIMIT plus the selected one, or every
 * event after "Show all". Selection is single; clicking it again clears it.
 */
function EventList({
	events,
	selectedEvent,
	onSelect,
}: {
	events: EventSummary[];
	selectedEvent: EventSummary | null;
	onSelect: (event: EventSummary | null) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const preview = showAll ? events : events.slice(0, FILTER_PREVIEW_LIMIT);
	// Keep the selection reachable when it is collapsed away or out of scope.
	const visible =
		selectedEvent !== null && !preview.some((e) => e.id === selectedEvent.id)
			? [...preview, selectedEvent]
			: preview;

	return (
		<div data-testid="event-list">
			{visible.map((event) => {
				const selected = selectedEvent?.id === event.id;
				return (
					<button
						key={event.id}
						type="button"
						data-testid="event-row"
						data-event-id={event.id}
						aria-pressed={selected}
						onClick={() => onSelect(selected ? null : event)}
						className={cn(navRowClasses(selected), "py-1")}
					>
						<img
							src={getThumbnailUrl(
								event.cover.photoId,
								"tiny",
								event.cover.thumbnailUpdatedAt,
							)}
							alt=""
							className="h-9 w-9 shrink-0 rounded-md bg-secondary object-cover"
							loading="lazy"
							draggable={false}
						/>
						<span className="flex min-w-0 flex-1 flex-col">
							<span data-testid="event-title" className="truncate text-sm">
								{eventTitle(event)}
							</span>
							<span
								data-testid="event-subtitle"
								className="truncate text-2xs text-subtle"
							>
								{eventSubtitle(event)}
							</span>
						</span>
					</button>
				);
			})}
			<ShowAllToggle
				total={events.length}
				showAll={showAll}
				onToggle={() => setShowAll((current) => !current)}
			/>
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
			<div
				className={cn(navRowClasses(isSelected), "gap-1 py-0 pr-2")}
				style={{ paddingLeft: `${4 + depth * 16}px` }}
			>
				{hasChildren ? (
					<button
						type="button"
						aria-label={`${isExpanded ? "Collapse" : "Expand"} ${folder.name}`}
						aria-expanded={isExpanded}
						onClick={() => onToggleExpand(folder.path)}
						className="flex-shrink-0 rounded p-0.5 text-subtle hover:bg-accent hover:text-foreground"
					>
						<ChevronRight
							className={cn(
								"h-3 w-3 transition-transform",
								isExpanded && "rotate-90",
							)}
						/>
					</button>
				) : (
					<span className="w-4 flex-shrink-0" />
				)}
				<button
					type="button"
					onClick={() => onSelect(folder.path)}
					className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left focus-visible:outline-none"
				>
					<span
						className={cn(
							"flex-shrink-0",
							isSelected ? "text-primary" : "text-subtle",
						)}
					>
						{isSelected || isExpanded ? (
							<FolderOpen className="h-4 w-4" />
						) : (
							<Folder className="h-4 w-4" />
						)}
					</span>
					<span className="flex-1 truncate">{folder.name}</span>
					<span
						className={cn(
							"text-xs tabular-nums",
							isSelected ? "text-primary" : "text-subtle",
						)}
					>
						{folder.photoCount}
					</span>
				</button>
			</div>

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

function RailButton({
	label,
	icon,
	active,
	badge,
	toggle,
	onClick,
}: {
	label: string;
	icon: ReactNode;
	active?: boolean;
	badge?: number;
	toggle?: boolean;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={label}
					aria-pressed={toggle ? Boolean(active) : undefined}
					onClick={onClick}
					className={cn(
						"relative h-9 w-9",
						active && "bg-primary/15 text-primary hover:bg-primary/20",
					)}
				>
					{icon}
					{badge !== undefined && badge > 0 && (
						<span className="absolute right-0.5 top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-center text-[9px] font-semibold leading-3.5 text-primary-foreground">
							{badge}
						</span>
					)}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Navigation sidebar: library views, clean-up queues, collections, smart
 * albums, events, and folders. Filters live in the header's filter menu.
 * Collapses to an icon rail.
 */
export const AppSidebar = forwardRef<HTMLInputElement, AppSidebarProps>(
	function AppSidebar(
		{
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
			smartAlbums,
			selectedSmartAlbumId,
			onSmartAlbumSelect,
			onRenameSmartAlbum,
			onDeleteSmartAlbum,
			events,
			selectedEvent,
			onEventSelect,
			reviewCount,
			reviewActive,
			onReviewSelect,
			duplicateCount,
			duplicatesActive,
			onDuplicatesSelect,
			peopleCount,
			peopleActive,
			onPeopleSelect,
			searchQuery,
			onSearchChange,
			collapsed,
			onToggleCollapsed,
			activity,
		},
		searchRef,
	) {
		// Review, Duplicates, and People replace the library; its selection is not shown.
		const catalogViewActive = reviewActive || duplicatesActive || peopleActive;
		const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
			new Set(),
		);
		const [collectionsOpen, setCollectionsOpen] = useState(true);
		const [creatingCollection, setCreatingCollection] = useState(false);

		const handleToggleExpand = (path: string) => {
			setExpandedFolders((prev) => {
				const next = new Set(prev);
				if (next.has(path)) next.delete(path);
				else next.add(path);
				return next;
			});
		};

		const handleFolderSelect = (path: string) => {
			// Toggle selection - clicking same folder again shows all photos
			onFolderSelect(
				!catalogViewActive && selectedFolder === path ? null : path,
			);
		};

		const allPhotosActive =
			!catalogViewActive &&
			selectedFolder === null &&
			selectedCollectionId === null;

		if (collapsed) {
			return (
				<TooltipProvider delayDuration={200}>
					<div className="flex h-full flex-col items-center gap-1 py-3">
						<RailButton
							label="Expand sidebar"
							icon={<PanelLeftOpen className="h-4 w-4" />}
							onClick={onToggleCollapsed}
						/>
						<RailButton
							label="Search photos"
							icon={<Search className="h-4 w-4" />}
							onClick={onToggleCollapsed}
						/>
						<RailButton
							label="All Photos"
							icon={<Images className="h-4 w-4" />}
							active={allPhotosActive}
							onClick={() => onFolderSelect(null)}
						/>
						<RailButton
							label="People"
							icon={<Users className="h-4 w-4" />}
							active={peopleActive}
							toggle
							onClick={onPeopleSelect}
						/>
						<RailButton
							label="Review"
							icon={<ScanEye className="h-4 w-4" />}
							active={reviewActive}
							toggle
							badge={reviewCount}
							onClick={onReviewSelect}
						/>
						<RailButton
							label="Duplicates"
							icon={<Copy className="h-4 w-4" />}
							active={duplicatesActive}
							toggle
							onClick={onDuplicatesSelect}
						/>
					</div>
				</TooltipProvider>
			);
		}

		return (
			<div className="flex h-full flex-col">
				<div className="flex items-center gap-2 px-3 pb-2 pt-3">
					<span className="h-5 w-5 rounded-md bg-gradient-to-br from-primary to-primary/60" />
					<span className="flex-1 text-sm font-semibold">PhotoBrain</span>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Collapse sidebar"
						title="Collapse sidebar (⌘\)"
						onClick={onToggleCollapsed}
					>
						<PanelLeftClose className="h-4 w-4" />
					</Button>
				</div>
				<div className="relative mx-3 mb-2">
					<Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
					<Input
						ref={searchRef}
						type="text"
						placeholder="Search photos..."
						aria-keyshortcuts="Meta+K Control+K"
						value={searchQuery}
						onChange={(e) => onSearchChange(e.target.value)}
						className="h-8 pl-8 pr-9 text-xs"
					/>
					<kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1 text-2xs text-subtle">
						⌘K
					</kbd>
				</div>
				<div className="min-h-0 flex-1">
					<ScrollArea className="h-full">
						<div className="px-2 pb-2">
							<div className="mb-1">
								<NavItem
									icon={<Images className="h-4 w-4" />}
									label="All Photos"
									count={photoCount}
									active={allPhotosActive}
									onClick={() => onFolderSelect(null)}
								/>
								<NavItem
									icon={<Users className="h-4 w-4" />}
									label="People"
									count={peopleCount}
									active={peopleActive}
									toggle
									onClick={onPeopleSelect}
								/>
							</div>

							<Section title="Clean up">
								<NavItem
									icon={<ScanEye className="h-4 w-4" />}
									label="Review"
									count={reviewCount}
									active={reviewActive}
									toggle
									onClick={onReviewSelect}
								/>
								<NavItem
									icon={<Copy className="h-4 w-4" />}
									label="Duplicates"
									count={duplicateCount}
									active={duplicatesActive}
									toggle
									onClick={onDuplicatesSelect}
								/>
							</Section>

							<Section
								title="Collections"
								open={collectionsOpen}
								onOpenChange={setCollectionsOpen}
								actions={
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label="New collection"
										title="New collection"
										onClick={() => {
											setCollectionsOpen(true);
											setCreatingCollection(true);
										}}
										className="mr-1"
									>
										<Plus className="h-3.5 w-3.5" />
									</Button>
								}
							>
								<CollectionList
									collections={collections}
									selectedCollectionId={
										catalogViewActive ? null : selectedCollectionId
									}
									onSelect={(id) =>
										// Re-selecting the active collection returns to All Photos.
										onCollectionSelect(
											!catalogViewActive && selectedCollectionId === id
												? null
												: id,
										)
									}
									creating={creatingCollection}
									onCreatingChange={setCreatingCollection}
									onCreate={onCreateCollection}
									onRename={onRenameCollection}
									onDelete={onDeleteCollection}
								/>
							</Section>

							<Section title="Smart Albums">
								<SmartAlbumList
									albums={smartAlbums}
									selectedAlbumId={
										catalogViewActive ? null : selectedSmartAlbumId
									}
									onSelect={onSmartAlbumSelect}
									onRename={onRenameSmartAlbum}
									onDelete={onDeleteSmartAlbum}
								/>
							</Section>

							<Section title="Events">
								{events !== undefined &&
								events.length === 0 &&
								selectedEvent === null ? (
									<div className="px-2 py-2 text-xs text-subtle">
										No events yet
									</div>
								) : (
									<EventList
										events={events ?? []}
										// Review/Duplicates show no selection, so any click applies.
										selectedEvent={catalogViewActive ? null : selectedEvent}
										onSelect={onEventSelect}
									/>
								)}
							</Section>

							<Section title="Folders">
								{folders.length === 0 ? (
									<div className="px-2 py-4 text-center text-xs text-subtle">
										No folders found
									</div>
								) : (
									folders.map((folder) => (
										<FolderItem
											key={folder.path}
											folder={folder}
											depth={0}
											selectedFolder={catalogViewActive ? null : selectedFolder}
											expandedFolders={expandedFolders}
											onToggleExpand={handleToggleExpand}
											onSelect={handleFolderSelect}
										/>
									))
								)}
							</Section>
						</div>
					</ScrollArea>
				</div>
				{activity}
			</div>
		);
	},
);
