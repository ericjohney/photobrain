import { ChevronDown, Download, Layers } from "lucide-react";
import { useState } from "react";
import { MenuItem, MenuLink, Popover, RowActionsTrigger } from "@/components/ui/popover";
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
import { NavRow } from "@/components/ui/nav-row";
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
			<NavRow
				onClick={onSelect}
				aria-current={selected || undefined}
				selected={selected}
				icon={<Layers />}
				label={collection.name}
				trailing={collection.photoCount}
				trailingProps={{ "data-testid": "collection-count", className: "pr-5" }}
			/>
			<div ref={menuRef} className="absolute right-1 top-1/2 -translate-y-1/2">
				<RowActionsTrigger
					aria-label={`Collection actions for ${collection.name}`}
					open={menuOpen}
					onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
				/>
				{menuOpen && (
					<Popover
						role="menu"
						aria-label={`${collection.name} actions`}
						className="w-44"
					>
						<MenuItem
							onClick={() => {
								closeMenu();
								setRenaming(true);
							}}
						>
							Rename
						</MenuItem>
						<MenuItem
							aria-haspopup="menu"
							aria-expanded={zipOpen}
							onClick={() => setZipOpen((open) => !open)}
						>
							<Download className="h-3 w-3" />
							<span className="flex-1">Download as ZIP</span>
							<ChevronDown
								className={cn(
									"h-3 w-3 transition-transform",
									zipOpen && "rotate-180",
								)}
							/>
						</MenuItem>
						{zipOpen && (
							<div
								role="menu"
								aria-label={`Download ${collection.name} as ZIP`}
								className="ml-3 border-l border-border pl-1"
							>
								{EXPORT_SIZES.map((size) => (
									<MenuLink
										key={size}
										href={exportCollectionUrl(collection.id, size)}
										download={`${collection.name}.zip`}
										onClick={closeMenu}
									>
										{size === "original" ? "Originals" : `JPEG ${size}`}
									</MenuLink>
								))}
							</div>
						)}
						<MenuItem
							onClick={() => {
								closeMenu();
								onRequestDelete();
							}}
							tone="destructive"
						>
							Delete
						</MenuItem>
					</Popover>
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
				<div className="px-2 py-2 text-center text-xs text-subtle">
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
