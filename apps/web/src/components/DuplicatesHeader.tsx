import { Copy, X } from "lucide-react";
import { DUPLICATE_KIND_LABELS } from "@/lib/duplicates";
import type { DuplicateCounts, DuplicateKind } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_OPTIONS: { value: DuplicateKind | null; label: string }[] = [
	{ value: null, label: "All" },
	{ value: "duplicate", label: DUPLICATE_KIND_LABELS.duplicate },
	{ value: "burst", label: DUPLICATE_KIND_LABELS.burst },
];

interface DuplicatesHeaderProps {
	kind: DuplicateKind | null;
	onKindChange: (kind: DuplicateKind | null) => void;
	counts: DuplicateCounts | undefined;
	error: string | null;
	onDismissError: () => void;
	onExit: () => void;
}

/**
 * Duplicates banner above the group list: kind filter with library-wide group
 * counts, the last resolution error, and exit.
 */
export function DuplicatesHeader({
	kind,
	onKindChange,
	counts,
	error,
	onDismissError,
	onExit,
}: DuplicatesHeaderProps) {
	return (
		<div
			data-testid="duplicates-header"
			className="shrink-0 border-b border-border"
		>
			<div className="flex items-center gap-2 px-3 py-1.5 text-sm">
				<Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<h2 className="font-medium">Duplicates</h2>
				<div
					role="radiogroup"
					aria-label="Group kind"
					className="flex rounded bg-secondary p-0.5"
				>
					{KIND_OPTIONS.map((option) => {
						const checked = option.value === kind;
						const count = option.value && counts?.[option.value];
						return (
							<button
								key={option.label}
								type="button"
								role="radio"
								aria-checked={checked}
								onClick={() => onKindChange(option.value)}
								className={cn(
									"flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-xs transition-colors",
									checked
										? "bg-primary text-primary-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{option.label}
								{typeof count === "number" && (
									<span data-testid="kind-count" className="opacity-70">
										({count})
									</span>
								)}
							</button>
						);
					})}
				</div>
				<div className="flex-1" />
				<button
					type="button"
					aria-label="Exit duplicates"
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
		</div>
	);
}
