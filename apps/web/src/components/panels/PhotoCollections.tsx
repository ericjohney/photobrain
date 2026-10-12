import { Layers, Plus } from "lucide-react";
import { useState } from "react";
import {
	MenuItem,
	menuItemVariants,
	Popover,
} from "@/components/ui/popover";
import { CollectionNameInput } from "@/components/CollectionNameInput";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { useDismiss } from "@/hooks/use-dismiss";
import { trpc } from "@/lib/trpc";
import type { Collection } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface PhotoCollectionsProps {
	photoId: number;
	collections: Collection[] | undefined;
	/** Adds (`member`) or removes the photo; failures surface via `error`. */
	onSetMembership: (
		photoId: number,
		collectionId: number,
		member: boolean,
	) => Promise<void>;
	/** Creates a collection containing the photo; rejects for inline errors. */
	onCreate: (name: string, photoIds: number[]) => Promise<unknown>;
	error: string | null;
}

/**
 * Metadata-panel row: chips for the active photo's collections and an
 * "Add to collection" popover whose checkboxes add/remove immediately.
 */
export function PhotoCollections({
	photoId,
	collections,
	onSetMembership,
	onCreate,
	error,
}: PhotoCollectionsProps) {
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const popoverRef = useDismiss<HTMLDivElement>(open, () => {
		setOpen(false);
		setCreating(false);
	});
	const membershipQuery = trpc.collectionsForPhoto.useQuery({ photoId });
	const memberIds = membershipQuery.data?.collectionIds ?? [];
	const memberships = (collections ?? []).filter((c) =>
		memberIds.includes(c.id),
	);

	return (
		<div
			data-testid="photo-collections"
			className="border-b border-border px-3 py-2"
		>
			<div className="flex items-center gap-2">
				<span className="metadata-label flex items-center gap-1.5 text-xs">
					<Layers className="h-3.5 w-3.5" />
					Collections
				</span>
				<div ref={popoverRef} className="relative ml-auto">
					<Button
						variant="ghost"
						size="xs"
						aria-haspopup="dialog"
						aria-expanded={open}
						title="Add to collection (B adds to the last used)"
						onClick={() => {
							setOpen((current) => !current);
							setCreating(false);
						}}
						className="h-6 px-1.5"
					>
						<Plus />
						Add to collection
					</Button>
					{open && (
						<Popover
							role="dialog"
							aria-label="Add to collection"
							className="w-56"
						>
							<div className="max-h-56 overflow-auto">
								{collections?.map((collection) => {
									const checked = memberIds.includes(collection.id);
									return (
										<label
											key={collection.id}
											className={cn(menuItemVariants(), "gap-2")}
										>
											<input
												type="checkbox"
												checked={checked}
												disabled={!membershipQuery.data}
												onChange={() =>
													void onSetMembership(photoId, collection.id, !checked)
												}
												className="h-3.5 w-3.5 accent-primary"
											/>
											<span className="flex-1 truncate">{collection.name}</span>
											<span className="text-subtle tabular-nums">
												{collection.photoCount}
											</span>
										</label>
									);
								})}
								{collections?.length === 0 && (
									<p className="px-2 py-1 text-xs text-muted-foreground">
										No collections yet
									</p>
								)}
							</div>
							<div className="mt-1 border-t border-border pt-1">
								{creating ? (
									<CollectionNameInput
										ariaLabel="New collection name"
										onSubmit={async (name) => {
											await onCreate(name, [photoId]);
											setCreating(false);
										}}
										onCancel={() => setCreating(false)}
										className="px-1 py-0.5"
									/>
								) : (
									<MenuItem role={undefined} onClick={() => setCreating(true)}>
										New collection…
									</MenuItem>
								)}
							</div>
						</Popover>
					)}
				</div>
			</div>
			<ul
				aria-label="Photo collections"
				className={cn(
					"flex flex-wrap gap-1",
					memberships.length > 0 && "mt-1.5",
				)}
			>
				{memberships.map((collection) => (
					<li key={collection.id}>
						<Chip>{collection.name}</Chip>
					</li>
				))}
			</ul>
			{(error || membershipQuery.error) && (
				<p role="alert" className="mt-1 text-2xs text-destructive">
					{error ?? membershipQuery.error?.message}
				</p>
			)}
		</div>
	);
}
