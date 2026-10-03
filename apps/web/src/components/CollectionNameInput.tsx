import { useState } from "react";
import { collectionErrorMessage } from "@/hooks/use-collections";
import { cn } from "@/lib/utils";

interface CollectionNameInputProps {
	ariaLabel: string;
	placeholder?: string;
	initialValue?: string;
	/** Rejecting keeps the field open and shows the error inline. */
	onSubmit: (name: string) => Promise<unknown>;
	onCancel?: () => void;
	/** Maps a failed submit to its inline message; defaults to collection wording. */
	errorMessage?: (error: unknown, name: string) => string;
	className?: string;
}

/**
 * Inline collection-name field: Enter submits a trimmed non-empty name,
 * Escape (or blurring an untouched field) cancels, and a failed submit, such
 * as a duplicate name, is shown beneath the field.
 */
export function CollectionNameInput({
	ariaLabel,
	placeholder = "Collection name",
	initialValue = "",
	onSubmit,
	onCancel,
	errorMessage = collectionErrorMessage,
	className,
}: CollectionNameInputProps) {
	const [value, setValue] = useState(initialValue);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const submit = async () => {
		const name = value.trim();
		if (!name || pending) return;
		if (name === initialValue) {
			onCancel?.();
			return;
		}
		setPending(true);
		setError(null);
		try {
			await onSubmit(name);
		} catch (submitError) {
			setError(errorMessage(submitError, name));
		} finally {
			setPending(false);
		}
	};

	return (
		<div className={className}>
			<input
				// biome-ignore lint/a11y/noAutofocus: opened by an explicit user action
				autoFocus
				type="text"
				aria-label={ariaLabel}
				aria-invalid={error !== null}
				placeholder={placeholder}
				value={value}
				maxLength={100}
				disabled={pending}
				onChange={(e) => {
					setValue(e.target.value);
					setError(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void submit();
					} else if (e.key === "Escape" && onCancel) {
						// Keep Escape from also dismissing an enclosing popover/menu.
						e.preventDefault();
						e.stopPropagation();
						onCancel();
					}
				}}
				onBlur={() => {
					if (!pending && value.trim() === initialValue) onCancel?.();
				}}
				className={cn(
					"h-7 w-full rounded border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					error && "border-destructive focus-visible:ring-destructive",
				)}
			/>
			{error && (
				<p role="alert" className="mt-1 text-2xs text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
