import { Ellipsis, ListFilter, Search } from "lucide-react";
import { useState } from "react";
import { CollectionNameInput } from "@/components/CollectionNameInput";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useDismiss } from "@/hooks/use-dismiss";
import { smartAlbumErrorMessage } from "@/hooks/use-smart-albums";
import type { SmartAlbum } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface SmartAlbumListProps {
	albums: SmartAlbum[] | undefined;
	selectedAlbumId: number | null;
	onSelect: (album: SmartAlbum) => void;
	onRename: (albumId: number, name: string) => Promise<unknown>;
	onDelete: (albumId: number) => Promise<unknown>;
}

function SmartAlbumRow({
	album,
	selected,
	onSelect,
	onRename,
	onRequestDelete,
}: {
	album: SmartAlbum;
	selected: boolean;
	onSelect: () => void;
	onRename: (name: string) => Promise<unknown>;
	onRequestDelete: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const menuRef = useDismiss<HTMLDivElement>(menuOpen, () =>
		setMenuOpen(false),
	);

	if (renaming) {
		return (
			<CollectionNameInput
				ariaLabel={`Rename ${album.name}`}
				placeholder="Smart album name"
				initialValue={album.name}
				errorMessage={smartAlbumErrorMessage}
				onSubmit={async (name) => {
					await onRename(name);
					setRenaming(false);
				}}
				onCancel={() => setRenaming(false)}
				className="px-2 py-1"
			/>
		);
	}

	return (
		<div
			data-testid="smart-album-row"
			data-smart-album-id={album.id}
			// The open menu overlaps the rows below; lift this row above them.
			className={cn("group relative", menuOpen && "z-10")}
		>
			<button
				type="button"
				onClick={onSelect}
				aria-current={selected || undefined}
				className={cn(
					"flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
					"hover:bg-secondary/50",
					selected && "bg-primary/10 text-primary",
				)}
			>
				<ListFilter className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
				<span className="flex-1 truncate">{album.name}</span>
				<span
					data-testid="smart-album-count"
					className="pr-5 text-xs text-muted-foreground"
				>
					{album.photoCount === null ? (
						// Query albums have no stable count (vector search).
						<Search className="h-3 w-3" aria-label="Search album" />
					) : (
						album.photoCount
					)}
				</span>
			</button>
			<div ref={menuRef} className="absolute right-1 top-1/2 -translate-y-1/2">
				<button
					type="button"
					aria-label={`Smart album actions for ${album.name}`}
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					onClick={() => setMenuOpen((open) => !open)}
					className={cn(
						"rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:opacity-100",
						menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
					)}
				>
					<Ellipsis className="h-3.5 w-3.5" />
				</button>
				{menuOpen && (
					<div
						role="menu"
						aria-label={`${album.name} actions`}
						className="absolute right-0 top-full z-20 mt-1 w-28 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
					>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								setMenuOpen(false);
								setRenaming(true);
							}}
							className="w-full rounded px-2 py-1 text-left text-xs hover:bg-secondary"
						>
							Rename
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								setMenuOpen(false);
								onRequestDelete();
							}}
							className="w-full rounded px-2 py-1 text-left text-xs text-destructive hover:bg-secondary"
						>
							Delete
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

/** The library panel's smart albums: apply, rename, delete. */
export function SmartAlbumList({
	albums,
	selectedAlbumId,
	onSelect,
	onRename,
	onDelete,
}: SmartAlbumListProps) {
	const [pendingDelete, setPendingDelete] = useState<SmartAlbum | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);

	const confirmDelete = async () => {
		if (!pendingDelete) return;
		setDeleting(true);
		setDeleteError(null);
		try {
			await onDelete(pendingDelete.id);
			setPendingDelete(null);
		} catch (error) {
			setDeleteError(smartAlbumErrorMessage(error));
		} finally {
			setDeleting(false);
		}
	};

	return (
		<div data-testid="smart-album-list">
			{albums?.map((album) => (
				<SmartAlbumRow
					key={album.id}
					album={album}
					selected={selectedAlbumId === album.id}
					onSelect={() => onSelect(album)}
					onRename={(name) => onRename(album.id, name)}
					onRequestDelete={() => {
						setDeleteError(null);
						setPendingDelete(album);
					}}
				/>
			))}
			{albums?.length === 0 && (
				<div className="px-2 py-2 text-center text-xs text-muted-foreground">
					No smart albums yet
				</div>
			)}

			<Sheet
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open && !deleting) setPendingDelete(null);
				}}
			>
				<SheetContent>
					<SheetHeader>
						<SheetTitle>{`Delete “${pendingDelete?.name ?? ""}”?`}</SheetTitle>
						<SheetDescription>
							The saved filters are removed. No photos are changed.
						</SheetDescription>
					</SheetHeader>
					{deleteError && (
						<p role="alert" className="mt-4 text-sm text-destructive">
							{deleteError}
						</p>
					)}
					<SheetFooter className="mt-6 gap-2">
						<SheetClose asChild>
							<Button variant="outline" disabled={deleting}>
								Cancel
							</Button>
						</SheetClose>
						<Button
							variant="destructive"
							disabled={deleting}
							onClick={() => void confirmDelete()}
						>
							Delete smart album
						</Button>
					</SheetFooter>
				</SheetContent>
			</Sheet>
		</div>
	);
}
