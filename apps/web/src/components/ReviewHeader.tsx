import { Check, ScanEye, X } from "lucide-react";
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
import {
	JUNK_REASON_LABELS,
	JUNK_REASONS,
	REJECT_ALL_CONFIRM_THRESHOLD,
} from "@/lib/junk-review";
import type { JunkCounts, JunkReason } from "@/lib/types";
import { cn } from "@/lib/utils";

const REASON_OPTIONS: { value: JunkReason | null; label: string }[] = [
	{ value: null, label: "All" },
	...JUNK_REASONS.map((value) => ({ value, label: JUNK_REASON_LABELS[value] })),
];

interface ReviewHeaderProps {
	reason: JunkReason | null;
	onReasonChange: (reason: JunkReason | null) => void;
	counts: JunkCounts | undefined;
	/** Number of photos currently shown, which the bulk actions resolve. */
	shownCount: number;
	onRejectAll: () => void;
	onKeepAll: () => void;
	error: string | null;
	onDismissError: () => void;
	onExit: () => void;
}

/**
 * Review banner above the grid: reason filter with candidate counts, bulk
 * Reject/Keep for the shown photos (rejecting more than
 * REJECT_ALL_CONFIRM_THRESHOLD asks first), and the last resolution error.
 */
export function ReviewHeader({
	reason,
	onReasonChange,
	counts,
	shownCount,
	onRejectAll,
	onKeepAll,
	error,
	onDismissError,
	onExit,
}: ReviewHeaderProps) {
	const [confirmingReject, setConfirmingReject] = useState(false);

	return (
		<div
			data-testid="review-header"
			className="shrink-0 border-b border-border"
		>
			<div className="flex items-center gap-2 px-3 py-1.5 text-sm">
				<ScanEye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<h2 className="font-medium">Review</h2>
				<div
					role="radiogroup"
					aria-label="Review reason"
					className="flex rounded bg-secondary p-0.5"
				>
					{REASON_OPTIONS.map((option) => {
						const checked = option.value === reason;
						const count = counts?.[option.value ?? "all"];
						return (
							<button
								key={option.label}
								type="button"
								role="radio"
								aria-checked={checked}
								onClick={() => onReasonChange(option.value)}
								className={cn(
									"flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-xs transition-colors",
									checked
										? "bg-primary text-primary-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{option.label}
								{count !== undefined && (
									<span data-testid="reason-count" className="opacity-70">
										{count}
									</span>
								)}
							</button>
						);
					})}
				</div>
				<div className="flex-1" />
				<Button
					variant="outline"
					size="sm"
					className="h-7 text-xs"
					disabled={shownCount === 0}
					onClick={() => {
						if (shownCount > REJECT_ALL_CONFIRM_THRESHOLD) {
							setConfirmingReject(true);
						} else {
							onRejectAll();
						}
					}}
				>
					<X className="h-3.5 w-3.5" />
					Reject all ({shownCount})
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-7 text-xs"
					disabled={shownCount === 0}
					onClick={onKeepAll}
				>
					<Check className="h-3.5 w-3.5" />
					Keep all ({shownCount})
				</Button>
				<button
					type="button"
					aria-label="Exit review"
					onClick={onExit}
					className="rounded-full p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			</div>
			{error && (
				<div
					role="alert"
					className="flex items-center gap-2 bg-destructive/10 px-3 py-1 text-xs text-destructive"
				>
					<span className="flex-1">{error}</span>
					<button
						type="button"
						aria-label="Dismiss error"
						onClick={onDismissError}
						className="rounded-full p-0.5 hover:bg-destructive/20"
					>
						<X className="h-3 w-3" />
					</button>
				</div>
			)}

			<Sheet open={confirmingReject} onOpenChange={setConfirmingReject}>
				<SheetContent>
					<SheetHeader>
						<SheetTitle>{`Reject ${shownCount} photos?`}</SheetTitle>
						<SheetDescription>
							Every photo shown in Review is flagged as rejected. Files are not
							deleted, and you can unflag them later.
						</SheetDescription>
					</SheetHeader>
					<SheetFooter className="mt-6 gap-2">
						<SheetClose asChild>
							<Button variant="outline">Cancel</Button>
						</SheetClose>
						<Button
							variant="destructive"
							onClick={() => {
								setConfirmingReject(false);
								onRejectAll();
							}}
						>
							Reject {shownCount} photos
						</Button>
					</SheetFooter>
				</SheetContent>
			</Sheet>
		</div>
	);
}
