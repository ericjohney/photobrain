import { Users } from "lucide-react";
import { useId, useState } from "react";
import { useDismiss } from "@/hooks/use-dismiss";
import { type FaceAssignment, useAssignFace } from "@/hooks/use-people";
import { getFaceCropUrl } from "@/lib/thumbnails";
import { trpc } from "@/lib/trpc";
import type { PhotoFace } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The face row's element id, focused when its loupe box is clicked. */
export function faceRowId(faceId: number) {
	return `face-row-${faceId}`;
}

type Option = { key: string; label: string; assignment: FaceAssignment };

/**
 * Assign combobox: typing filters people by name; options are
 * "New person: {typed}", matching people, and "Not this person".
 */
function FaceAssignCombobox({
	face,
	onAssign,
}: {
	face: PhotoFace;
	onAssign: (assignment: FaceAssignment) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [highlighted, setHighlighted] = useState(0);
	const listId = useId();
	const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
	const peopleQuery = trpc.people.useQuery(undefined, { enabled: open });
	const typed = query.trim();
	const needle = typed.toLowerCase();
	const options: Option[] = [
		...(typed
			? [
					{
						key: "new",
						label: `New person: ${typed}`,
						assignment: { name: typed },
					},
				]
			: []),
		...(peopleQuery.data?.people ?? [])
			.filter(
				(p) =>
					p.name !== null &&
					p.id !== face.personId &&
					p.name.toLowerCase().includes(needle),
			)
			.map((p) => ({
				key: `person-${p.id}`,
				label: p.name ?? "",
				assignment: { personId: p.id, personName: p.name },
			})),
		...(face.assignment === "rejected"
			? []
			: [
					{
						key: "reject",
						label: "Not this person",
						assignment: { personId: null } as const,
					},
				]),
	];

	const choose = (option: Option) => {
		setOpen(false);
		setQuery("");
		onAssign(option.assignment);
	};

	return (
		<div ref={ref} className="relative min-w-0 flex-1">
			<input
				type="text"
				role="combobox"
				aria-label={`Assign face ${face.id}`}
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				placeholder="Assign…"
				value={query}
				maxLength={80}
				onFocus={() => setOpen(true)}
				onChange={(e) => {
					setQuery(e.target.value);
					setHighlighted(0);
					setOpen(true);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setOpen(true);
						setHighlighted((i) => Math.min(i + 1, options.length - 1));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setHighlighted((i) => Math.max(i - 1, 0));
					} else if (e.key === "Enter" && open && options[highlighted]) {
						e.preventDefault();
						choose(options[highlighted]);
					} else if (e.key === "Escape") {
						setOpen(false);
					}
				}}
				className="h-6 w-full rounded border border-input bg-background px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			/>
			{open && options.length > 0 && (
				<ul
					id={listId}
					role="listbox"
					aria-label={`People for face ${face.id}`}
					className="absolute right-0 top-full z-20 mt-1 max-h-48 w-full min-w-40 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
				>
					{options.map((option, index) => (
						<li
							key={option.key}
							role="option"
							aria-selected={index === highlighted}
							// Keep focus in the input until the choice lands.
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => choose(option)}
							onMouseEnter={() => setHighlighted(index)}
							className={cn(
								"cursor-pointer truncate rounded px-2 py-1 text-xs",
								index === highlighted && "bg-secondary",
								option.key === "reject" && "text-destructive",
							)}
						>
							{option.label}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * Metadata-panel People section (stills only): one row per detected face,
 * left to right, with its crop, person (or "Unknown"/"Not assigned"), and an
 * assign combobox. Assignments are optimistic with rollback.
 */
export function PhotoPeople({ photoId }: { photoId: number }) {
	const facesQuery = trpc.photoFaces.useQuery({ photoId });
	const { assign, error } = useAssignFace(photoId);
	const faces = facesQuery.data?.faces;

	return (
		<div
			data-testid="photo-people"
			className="border-b border-border px-3 py-2"
		>
			<span className="metadata-label flex items-center gap-1.5 text-xs">
				<Users className="h-3.5 w-3.5" />
				People
			</span>
			{faces && faces.length > 0 && (
				<ul aria-label="Faces" className="mt-1.5 space-y-1">
					{faces.map((face) => (
						<li
							key={face.id}
							id={faceRowId(face.id)}
							data-testid="face-row"
							data-face-id={face.id}
							tabIndex={-1}
							className="flex items-center gap-2 rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus:bg-primary/10"
						>
							<img
								src={getFaceCropUrl(face.id, 128)}
								alt=""
								className="h-8 w-8 shrink-0 rounded-full bg-secondary object-cover"
								draggable={false}
							/>
							<span
								data-testid="face-name"
								className={cn(
									"min-w-0 flex-1 truncate text-xs",
									face.personName === null && "text-muted-foreground",
								)}
							>
								{face.personName ??
									(face.assignment === "rejected" ? "Not assigned" : "Unknown")}
							</span>
							<FaceAssignCombobox
								face={face}
								onAssign={(assignment) => void assign(face, assignment)}
							/>
						</li>
					))}
				</ul>
			)}
			{faces?.length === 0 && (
				<p className="mt-1 text-2xs text-muted-foreground">No faces found</p>
			)}
			{(error ?? facesQuery.error?.message) && (
				<p role="alert" className="mt-1 text-2xs text-destructive">
					{error ?? facesQuery.error?.message}
				</p>
			)}
		</div>
	);
}
