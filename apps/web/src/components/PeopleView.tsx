import { Merge, Users } from "lucide-react";
import { useState } from "react";
import {
	MenuItem,
	MenuOption,
	Popover,
	RowActionsTrigger,
} from "@/components/ui/popover";
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
import { EmptyState, Spinner } from "@/components/ui/empty-state";
import { AlertBanner, ViewHeader } from "@/components/ui/view-header";
import { useDismiss } from "@/hooks/use-dismiss";
import { personName } from "@/hooks/use-people";
import { getFaceCropUrl } from "@/lib/thumbnails";
import type { Person } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PeopleViewProps {
	/** In API order (named first, then photo count). */
	people: readonly Person[];
	loading: boolean;
	loadError: string | null;
	showHidden: boolean;
	onShowHiddenChange: (showHidden: boolean) => void;
	/** Scopes the library to the person (outside merge mode). */
	onSelect: (person: Person) => void;
	/** `null` clears the name. */
	onRename: (person: Person, name: string | null) => void;
	onSetHidden: (person: Person, hidden: boolean) => void;
	onMerge: (target: Person, sources: Person[]) => void;
	/** The last failed mutation; restored state is already shown. */
	error: string | null;
	onDismissError: () => void;
	onExit: () => void;
}

/** Round face crop of the cover, or the name's initial ("?" when unnamed). */
function PersonAvatar({ person }: { person: Person }) {
	if (person.coverFaceId !== null) {
		return (
			<img
				data-testid="person-avatar"
				src={getFaceCropUrl(person.coverFaceId)}
				alt=""
				className="h-20 w-20 rounded-full bg-secondary object-cover"
				draggable={false}
			/>
		);
	}
	return (
		<span
			data-testid="person-avatar-placeholder"
			aria-hidden="true"
			className="flex h-20 w-20 items-center justify-center rounded-full bg-secondary text-2xl font-medium text-muted-foreground"
		>
			{person.name?.charAt(0).toUpperCase() ?? "?"}
		</span>
	);
}

/**
 * Inline person-name field: Enter saves the trimmed name (empty clears it),
 * Escape or blurring cancels.
 */
function PersonNameInput({
	person,
	onSubmit,
	onCancel,
}: {
	person: Person;
	onSubmit: (name: string | null) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(person.name ?? "");
	return (
		<input
			// biome-ignore lint/a11y/noAutofocus: opened by an explicit user action
			autoFocus
			type="text"
			aria-label={`Name for ${personName(person)}`}
			placeholder="Add a name"
			value={value}
			maxLength={80}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					const name = value.trim() || null;
					if (name === person.name) onCancel();
					else onSubmit(name);
				} else if (e.key === "Escape") {
					// Keep Escape from also dismissing an enclosing menu.
					e.preventDefault();
					e.stopPropagation();
					onCancel();
				}
			}}
			onBlur={onCancel}
			className="h-7 w-full rounded border border-input bg-background px-2 text-center text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
		/>
	);
}

function PersonCard({
	person,
	mergeMode,
	selected,
	onActivate,
	onRename,
	onSetHidden,
	onStartMerge,
}: {
	person: Person;
	mergeMode: boolean;
	selected: boolean;
	/** Scope to the person, or toggle its merge selection. */
	onActivate: () => void;
	onRename: (name: string | null) => void;
	onSetHidden: (hidden: boolean) => void;
	onStartMerge: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const menuRef = useDismiss<HTMLDivElement>(menuOpen, () =>
		setMenuOpen(false),
	);
	const label = personName(person);

	return (
		<li
			data-testid="person-card"
			data-person-id={person.id}
			className={cn(
				"group relative flex flex-col items-center gap-1 rounded-md p-2 text-center",
				selected ? "bg-primary/15" : "hover:bg-secondary/50",
				person.hidden && "opacity-60",
			)}
		>
			{mergeMode && (
				<input
					type="checkbox"
					aria-label={`Select ${label}`}
					checked={selected}
					onChange={onActivate}
					className="absolute left-2 top-2 h-4 w-4 accent-primary"
				/>
			)}
			<button
				type="button"
				aria-label={mergeMode ? `Toggle ${label}` : `Show photos of ${label}`}
				onClick={onActivate}
				className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<PersonAvatar person={person} />
			</button>
			{renaming ? (
				<PersonNameInput
					person={person}
					onSubmit={(name) => {
						setRenaming(false);
						onRename(name);
					}}
					onCancel={() => setRenaming(false)}
				/>
			) : person.name === null ? (
				<button
					type="button"
					onClick={() => setRenaming(true)}
					className="text-xs italic text-muted-foreground hover:text-foreground"
				>
					Add a name
				</button>
			) : (
				<span
					data-testid="person-name"
					className="w-full truncate text-sm font-medium"
				>
					{person.name}
				</span>
			)}
			<span
				data-testid="person-count"
				className="text-2xs text-muted-foreground"
			>
				{person.photoCount} {person.photoCount === 1 ? "photo" : "photos"}
				{person.hidden ? " · Hidden" : ""}
			</span>
			{!mergeMode && (
				<div ref={menuRef} className="absolute right-1 top-1">
					<RowActionsTrigger
						aria-label={`Person actions for ${label}`}
						open={menuOpen}
						onClick={() => setMenuOpen((open) => !open)}
					/>
					{menuOpen && (
						<Popover
							role="menu"
							aria-label={`${label} actions`}
							className="w-32"
						>
							<MenuItem
								onClick={() => {
									setMenuOpen(false);
									setRenaming(true);
								}}
							>
								Rename
							</MenuItem>
							<MenuItem
								onClick={() => {
									setMenuOpen(false);
									onSetHidden(!person.hidden);
								}}
							>
								{person.hidden ? "Unhide" : "Hide"}
							</MenuItem>
							<MenuItem
								onClick={() => {
									setMenuOpen(false);
									onStartMerge();
								}}
							>
								Merge
							</MenuItem>
						</Popover>
					)}
				</div>
			)}
		</li>
	);
}

/**
 * Catalog People view: a header (Show hidden, merge controls, the last error)
 * over a responsive grid of person cards in API order. Merge mode selects
 * cards with checkboxes, picks the surviving person among the selection, and
 * confirms before merging the others into it.
 */
export function PeopleView({
	people,
	loading,
	loadError,
	showHidden,
	onShowHiddenChange,
	onSelect,
	onRename,
	onSetHidden,
	onMerge,
	error,
	onDismissError,
	onExit,
}: PeopleViewProps) {
	// Selected ids in selection order; null outside merge mode.
	const [mergeSelection, setMergeSelection] = useState<number[] | null>(null);
	const [pickingTarget, setPickingTarget] = useState(false);
	const [mergeTarget, setMergeTarget] = useState<Person | null>(null);
	const pickerRef = useDismiss<HTMLDivElement>(pickingTarget, () =>
		setPickingTarget(false),
	);
	const mergeMode = mergeSelection !== null;
	// Selected people still listed (a refetch may drop merged or hidden ones).
	const selectedPeople = (mergeSelection ?? []).flatMap((id) => {
		const person = people.find((p) => p.id === id);
		return person ? [person] : [];
	});

	const toggleSelected = (id: number) =>
		setMergeSelection((current) =>
			current?.includes(id)
				? current.filter((selected) => selected !== id)
				: [...(current ?? []), id],
		);
	const exitMergeMode = () => {
		setMergeSelection(null);
		setPickingTarget(false);
		setMergeTarget(null);
	};
	const confirmMerge = () => {
		if (!mergeTarget) return;
		onMerge(
			mergeTarget,
			selectedPeople.filter((p) => p.id !== mergeTarget.id),
		);
		exitMergeMode();
	};

	return (
		<div data-testid="people-view" className="flex h-full flex-col">
			<div
				data-testid="people-header"
				className="shrink-0 border-b border-border"
			>
				<ViewHeader
					bordered={false}
					icon={<Users />}
					title="People"
					exitLabel="Exit people"
					onExit={onExit}
				>
					{mergeMode ? (
						<>
							<span className="text-xs text-muted-foreground">
								{selectedPeople.length} selected
							</span>
							<div ref={pickerRef} className="relative">
								<Button
									size="xs"
									aria-haspopup="listbox"
									aria-expanded={pickingTarget}
									disabled={selectedPeople.length < 2}
									onClick={() => setPickingTarget((open) => !open)}
								>
									<Merge />
									Merge into...
								</Button>
								{pickingTarget && (
									<Popover
										as="ul"
										role="listbox"
										aria-label="Merge into"
										align="start"
										className="w-48"
									>
										{selectedPeople.map((person) => (
											<MenuOption
												key={person.id}
												aria-selected={false}
												tabIndex={0}
												onClick={() => {
													setPickingTarget(false);
													setMergeTarget(person);
												}}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														setPickingTarget(false);
														setMergeTarget(person);
													}
												}}
											>
												{personName(person)}
											</MenuOption>
										))}
									</Popover>
								)}
							</div>
							<Button variant="ghost" size="xs" onClick={exitMergeMode}>
								Cancel merge
							</Button>
						</>
					) : (
						<Button
							variant="ghost"
							size="xs"
							aria-pressed={showHidden}
							onClick={() => onShowHiddenChange(!showHidden)}
						>
							Show hidden
						</Button>
					)}
				</ViewHeader>
				{error && (
					<AlertBanner onDismiss={onDismissError}>{error}</AlertBanner>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{loading ? (
					<Spinner />
				) : loadError ? (
					<p role="alert" className="p-6 text-center text-sm text-destructive">
						{loadError}
					</p>
				) : people.length === 0 ? (
					<EmptyState
						data-testid="people-empty"
						icon={<Users />}
						title="No people yet"
					/>
				) : (
					<ul
						aria-label="People"
						className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2 p-3"
					>
						{people.map((person) => (
							<PersonCard
								key={person.id}
								person={person}
								mergeMode={mergeMode}
								selected={mergeSelection?.includes(person.id) ?? false}
								onActivate={() =>
									mergeMode ? toggleSelected(person.id) : onSelect(person)
								}
								onRename={(name) => onRename(person, name)}
								onSetHidden={(hidden) => onSetHidden(person, hidden)}
								onStartMerge={() => setMergeSelection([person.id])}
							/>
						))}
					</ul>
				)}
			</div>

			<Sheet
				open={mergeTarget !== null}
				onOpenChange={(open) => {
					if (!open) setMergeTarget(null);
				}}
			>
				<SheetContent>
					<SheetHeader>
						<SheetTitle>
							{`Merge ${selectedPeople.length} people into “${mergeTarget ? personName(mergeTarget) : ""}”?`}
						</SheetTitle>
						<SheetDescription>
							Their faces move to this person and the others are removed.
						</SheetDescription>
					</SheetHeader>
					<SheetFooter className="mt-6 gap-2">
						<SheetClose asChild>
							<Button variant="outline">Cancel</Button>
						</SheetClose>
						<Button onClick={confirmMerge}>Merge people</Button>
					</SheetFooter>
				</SheetContent>
			</Sheet>
		</div>
	);
}
