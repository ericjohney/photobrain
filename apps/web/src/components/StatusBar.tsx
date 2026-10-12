import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export type StatusMode =
	| "library"
	| "loupe"
	| "review"
	| "duplicates"
	| "people";

interface StatusBarProps {
	mode: StatusMode;
	/** Photos listed / total in the library. */
	shown: number;
	total?: number;
	hasActivePhoto: boolean;
	/** Loupe: "5 of 214 · name". */
	loupeLabel?: string;
	/** Review candidates / duplicate groups. */
	queueLabel?: string;
	/** Active scan/indexing progress. */
	progress?: { active: boolean; label: string; percentage: number };
}

function Kbd({ children }: { children: ReactNode }) {
	return (
		<kbd className="mr-1 rounded border border-border px-1 text-2xs text-muted-foreground">
			{children}
		</kbd>
	);
}

function Hint({ keys, label }: { keys: string; label: string }) {
	return (
		<span className="whitespace-nowrap">
			<Kbd>{keys}</Kbd>
			{label}
		</span>
	);
}

/** Footer status bar: counts, selection, indexing progress, and mode-specific key hints. */
export function StatusBar({
	mode,
	shown,
	total,
	hasActivePhoto,
	loupeLabel,
	queueLabel,
	progress,
}: StatusBarProps) {
	return (
		<footer
			data-testid="status-bar"
			className="flex h-7 items-center gap-4 px-3.5 text-[11.5px] text-subtle"
		>
			{mode === "loupe" && loupeLabel ? (
				<span className="truncate text-muted-foreground">{loupeLabel}</span>
			) : mode === "review" || mode === "duplicates" ? (
				<span className="text-muted-foreground">{queueLabel}</span>
			) : (
				<>
					<span>
						<b className="font-medium text-muted-foreground tabular-nums">
							{shown}
						</b>{" "}
						shown{total !== undefined && total !== shown ? ` of ${total}` : ""}
					</span>
					<span>
						<b className="font-medium text-muted-foreground">
							{hasActivePhoto ? 1 : 0}
						</b>{" "}
						selected
					</span>
				</>
			)}
			{progress?.active && (
				<span className="flex items-center gap-2">
					<Loader2 className="h-3 w-3 animate-spin text-primary" />
					{progress.label}
					<span className="h-1 w-20 overflow-hidden rounded-full bg-muted">
						<span
							className="block h-full bg-primary transition-all"
							style={{ width: `${progress.percentage}%` }}
						/>
					</span>
					<span className="tabular-nums">
						{Math.round(progress.percentage)}%
					</span>
				</span>
			)}
			<span className="ml-auto flex gap-3">
				{mode === "review" ? (
					<>
						<Hint keys="X" label="reject" />
						<Hint keys="K" label="keep" />
					</>
				) : mode === "loupe" ? (
					<>
						<Hint keys="←→" label="navigate" />
						<Hint keys="Esc" label="grid" />
					</>
				) : mode === "library" ? (
					<>
						<Hint keys="P" label="pick" />
						<Hint keys="X" label="reject" />
						<Hint keys="1–5" label="rate" />
						<Hint keys="E" label="loupe" />
						<Hint keys="S" label="similar" />
						<Hint keys="⌘K" label="search" />
					</>
				) : null}
			</span>
		</footer>
	);
}
