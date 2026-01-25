import {
	Calendar,
	Camera,
	ChevronRight,
	Clock,
	Folder,
	FolderOpen,
	Heart,
	Image,
	Images,
	MapPin,
	Star,
} from "lucide-react";
import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface FolderNode {
	name: string;
	path: string;
	photoCount: number;
	children: FolderNode[];
}

interface LibraryPanelProps {
	photoCount: number;
	searchQuery?: string;
	folders?: FolderNode[];
	selectedFolder: string | null;
	onFolderSelect: (folder: string | null) => void;
}

interface NavItemProps {
	icon: React.ReactNode;
	label: string;
	count?: number;
	active?: boolean;
	onClick?: () => void;
	indent?: number;
}

function NavItem({
	icon,
	label,
	count,
	active,
	onClick,
	indent = 0,
}: NavItemProps) {
	return (
		<button
			type="button"
			onClick={onClick}
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
}

function Section({ title, children, defaultOpen = true }: SectionProps) {
	const [open, setOpen] = useState(defaultOpen);

	return (
		<div className="mb-1">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex w-full items-center gap-1 px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
			>
				<ChevronRight
					className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
				/>
				{title}
			</button>
			{open && <div className="mt-0.5">{children}</div>}
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
	searchQuery,
	folders = [],
	selectedFolder,
	onFolderSelect,
}: LibraryPanelProps) {
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
		new Set(),
	);

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
						active={selectedFolder === null && !searchQuery}
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
				<Section title="Collections" defaultOpen={false}>
					<NavItem
						icon={<Heart className="h-4 w-4" />}
						label="Favorites"
						count={0}
					/>
					<NavItem
						icon={<Image className="h-4 w-4" />}
						label="Portfolio"
						count={0}
					/>
				</Section>

				{/* Filter By Section */}
				<Section title="Filter By" defaultOpen={false}>
					<NavItem icon={<Calendar className="h-4 w-4" />} label="Date" />
					<NavItem icon={<Camera className="h-4 w-4" />} label="Camera" />
					<NavItem icon={<MapPin className="h-4 w-4" />} label="Location" />
				</Section>

				{/* Search results indicator */}
				{searchQuery && (
					<div className="mt-4 rounded bg-primary/10 px-2 py-1.5 text-xs text-primary">
						Showing results for "{searchQuery}"
					</div>
				)}

				{/* Selected folder indicator */}
				{selectedFolder && !searchQuery && (
					<div className="mt-4 rounded bg-secondary px-2 py-1.5 text-xs text-muted-foreground">
						Showing: {selectedFolder}
					</div>
				)}
			</div>
		</ScrollArea>
	);
}
