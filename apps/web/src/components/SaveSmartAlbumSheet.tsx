import { useState } from "react";
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
import { smartAlbumErrorMessage } from "@/hooks/use-smart-albums";
import { cn } from "@/lib/utils";

interface SaveSmartAlbumSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Human-readable summary of what will be saved (query and filters). */
	summary: string;
	/** Rejecting keeps the sheet open and shows the error inline. */
	onSave: (name: string) => Promise<unknown>;
}

/** "Save as Smart Album…" name dialog for the current filters and search. */
export function SaveSmartAlbumSheet({
	open,
	onOpenChange,
	summary,
	onSave,
}: SaveSmartAlbumSheetProps) {
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const setOpen = (next: boolean) => {
		if (pending) return;
		if (!next) {
			setName("");
			setError(null);
		}
		onOpenChange(next);
	};

	const submit = async () => {
		const trimmed = name.trim();
		if (!trimmed || pending) return;
		setPending(true);
		setError(null);
		try {
			await onSave(trimmed);
			setName("");
			onOpenChange(false);
		} catch (saveError) {
			setError(smartAlbumErrorMessage(saveError, trimmed));
		} finally {
			setPending(false);
		}
	};

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetContent>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<SheetHeader>
						<SheetTitle>Save as Smart Album</SheetTitle>
						<SheetDescription>
							{summary}. The album stays up to date as your library changes.
						</SheetDescription>
					</SheetHeader>
					<input
						// biome-ignore lint/a11y/noAutofocus: opened by an explicit user action
						autoFocus
						type="text"
						aria-label="Smart album name"
						aria-invalid={error !== null}
						placeholder="Smart album name"
						value={name}
						maxLength={100}
						disabled={pending}
						onChange={(e) => {
							setName(e.target.value);
							setError(null);
						}}
						className={cn(
							"mt-4 h-8 w-full rounded border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							error && "border-destructive focus-visible:ring-destructive",
						)}
					/>
					{error && (
						<p role="alert" className="mt-2 text-sm text-destructive">
							{error}
						</p>
					)}
					<SheetFooter className="mt-6 gap-2">
						<SheetClose asChild>
							<Button type="button" variant="outline" disabled={pending}>
								Cancel
							</Button>
						</SheetClose>
						<Button type="submit" disabled={pending || !name.trim()}>
							Save smart album
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	);
}
