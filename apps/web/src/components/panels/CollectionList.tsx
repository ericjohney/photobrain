import { ChevronDown, Download, Ellipsis, Layers } from "lucide-react";
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
import { collectionErrorMessage } from "@/hooks/use-collections";
import { useDismiss } from "@/hooks/use-dismiss";
import { EXPORT_SIZES } from "@/lib/export";
import { exportCollectionUrl } from "@/lib/thumbnails";
import type { Collection } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface CollectionListProps {
	collections: Collection[] | undefined;
	selectedCollectionId: number | null;
	onSelect: (collectionId: number) => void;
	/** Whether the "+" inline name field is open. */
	creating: boolean;
	onCreatingChange: (creating: boolean) => void;
	onCreate: (name: string) => Promise<unknown>;
	onRename: (collectionId: number, name: string) => Promise<unknown>;
	onDelete: (collectionId: number) => Promise<unknown>;
}

function CollectionRow({
	collection,
	selected,
	onSelect,
	onRename,
	onRequestDelete,
}: {
	collection: Collection;
	selected: boolean;
	onSelect: () => void;
	onRename: (name: string) => Promise<unknown>;
	onRequestDelete: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [zipOpen, setZipOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const closeMenu = () => {
		setMenuOpen(false);
		setZipOpen(false);
	};
	const menuRef = useDismiss<HTMLDivElement>(menuOpen, closeMenu);

	if (renaming) {
		return (
			<CollectionNameInput
				ariaLabel={`Rename ${collection.name}`}
				initialValue={collection.name}
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
			data-testid="collection-row"
			data-collection-id={collection.id}
			className="group relative"
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
				<Layers className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
				<span className="flex-1 truncate">{collection.name}</span>
				<span
					data-testid="collection-count"
					className="pr-5 text-xs text-muted-foreground"
				>
					{collection.photoCount}
				</span>
			</button>
			<div ref={menuRef} className="absolute right-1 top-1/2 -translate-y-1/2">
				<button
					type="button"
					aria-label={`Collection actions for ${collection.name}`}
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
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
						aria-label={`${collection.name} actions`}
						className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
					>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								closeMenu();
								setRenaming(true);
							}}
							className="w-full rounded px-2 py-1 text-left text-xs hover:bg-secondary"
						>
							Rename
						</button>
						<button
							type="button"
							role="menuitem"
							aria-haspopup="menu"
							aria-expanded={zipOpen}
							onClick={() => setZipOpen((open) => !open)}
							className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs hover:bg-secondary"
						>
							<Download className="h-3 w-3" />
							<span className="flex-1">Download as ZIP</span>
							<ChevronDown
								className={cn(
									"h-3 w-3 transition-transform",
									zipOpen && "rotate-180",
								)}
							/>
						</button>
						{zipOpen && (
							<div
								role="menu"
								aria-label={`Download ${collection.name} as ZIP`}
								className="ml-3 border-l border-border pl-1"
							>
								{EXPORT_SIZES.map((size) => (
									<a
										key={size}
										role="menuitem"
										href={exportCollectionUrl(collection.id, size)}
										download={`${collection.name}.zip`}
										onClick={closeMenu}
										className="block rounded px-2 py-1 text-xs hover:bg-secondary"
									>
										{size === "original" ? "Originals" : `JPEG ${size}`}
									</a>
								))}
							</div>
						)}
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								closeMenu();
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

/** The library panel's collections: select, create ("+"), rename, delete. */
export function CollectionList({
	collections,
	selectedCollectionId,
	onSelect,
	creating,
	onCreatingChange,
	onCreate,
	onRename,
	onDelete,
}: CollectionListProps) {
	const [pendingDelete, setPendingDelete] = useState<Collection | null>(null);
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
			setDeleteError(collectionErrorMessage(error));
		} finally {
			setDeleting(false);
		}
	};

	return (
		<div data-testid="collection-list">
			{collections?.map((collection) => (
				<CollectionRow
					key={collection.id}
					collection={collection}
					selected={selectedCollectionId === collection.id}
					onSelect={() => onSelect(collection.id)}
					onRename={(name) => onRename(collection.id, name)}
					onRequestDelete={() => {
						setDeleteError(null);
						setPendingDelete(collection);
					}}
				/>
			))}
			{creating && (
				<CollectionNameInput
					ariaLabel="New collection name"
					onSubmit={async (name) => {
						await onCreate(name);
						onCreatingChange(false);
					}}
					onCancel={() => onCreatingChange(false)}
					className="px-2 py-1"
				/>
			)}
			{collections?.length === 0 && !creating && (
				<div className="px-2 py-2 text-center text-xs text-muted-foreground">
					No collections yet
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
							The collection is removed. Its photos stay in your library.
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
							Delete collection
						</Button>
					</SheetFooter>
				</SheetContent>
			</Sheet>
		</div>
	);
}
