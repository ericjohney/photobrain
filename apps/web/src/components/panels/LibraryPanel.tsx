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

interface LibraryPanelProps {
	photoCount: number;
	searchQuery?: string;
}

interface NavItemProps {
	icon: React.ReactNode;
	label: string;
	count?: number;
	active?: boolean;
	onClick?: () => void;
	indent?: boolean;
}

function NavItem({
	icon,
	label,
	count,
	active,
	onClick,
	indent,
}: NavItemProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
				"hover:bg-secondary/50",
				active && "bg-primary/10 text-primary",
				indent && "pl-6",
			)}
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

export function LibraryPanel({ photoCount, searchQuery }: LibraryPanelProps) {
	const [activeItem, setActiveItem] = useState("all");

	return (
		<ScrollArea className="h-full">
			<div className="p-2">
				{/* Catalog Section */}
				<Section title="Catalog">
					<NavItem
						icon={<Images className="h-4 w-4" />}
						label="All Photos"
						count={photoCount}
						active={activeItem === "all"}
						onClick={() => setActiveItem("all")}
					/>
					<NavItem
						icon={<Clock className="h-4 w-4" />}
						label="Recent Imports"
						count={0}
						active={activeItem === "recent"}
						onClick={() => setActiveItem("recent")}
					/>
					<NavItem
						icon={<Star className="h-4 w-4" />}
						label="Quick Collection"
						count={0}
						active={activeItem === "quick"}
						onClick={() => setActiveItem("quick")}
					/>
				</Section>

				{/* Folders Section */}
				<Section title="Folders">
					<NavItem
						icon={<FolderOpen className="h-4 w-4" />}
						label="temp-photos"
						active={activeItem === "folder-root"}
						onClick={() => setActiveItem("folder-root")}
					/>
					<NavItem
						icon={<Folder className="h-4 w-4" />}
						label="2024"
						indent
						active={activeItem === "folder-2024"}
						onClick={() => setActiveItem("folder-2024")}
					/>
					<NavItem
						icon={<Folder className="h-4 w-4" />}
						label="2023"
						indent
						active={activeItem === "folder-2023"}
						onClick={() => setActiveItem("folder-2023")}
					/>
				</Section>

				{/* Collections Section */}
				<Section title="Collections" defaultOpen={false}>
					<NavItem
						icon={<Heart className="h-4 w-4" />}
						label="Favorites"
						count={0}
						active={activeItem === "favorites"}
						onClick={() => setActiveItem("favorites")}
					/>
					<NavItem
						icon={<Image className="h-4 w-4" />}
						label="Portfolio"
						count={0}
						active={activeItem === "portfolio"}
						onClick={() => setActiveItem("portfolio")}
					/>
				</Section>

				{/* Filter By Section */}
				<Section title="Filter By" defaultOpen={false}>
					<NavItem
						icon={<Calendar className="h-4 w-4" />}
						label="Date"
						active={activeItem === "filter-date"}
						onClick={() => setActiveItem("filter-date")}
					/>
					<NavItem
						icon={<Camera className="h-4 w-4" />}
						label="Camera"
						active={activeItem === "filter-camera"}
						onClick={() => setActiveItem("filter-camera")}
					/>
					<NavItem
						icon={<MapPin className="h-4 w-4" />}
						label="Location"
						active={activeItem === "filter-location"}
						onClick={() => setActiveItem("filter-location")}
					/>
				</Section>

				{/* Search results indicator */}
				{searchQuery && (
					<div className="mt-4 rounded bg-primary/10 px-2 py-1.5 text-xs text-primary">
						Showing results for "{searchQuery}"
					</div>
				)}
			</div>
		</ScrollArea>
	);
}
