import { Copy } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AlertBanner, ViewHeader } from "@/components/ui/view-header";
import { DUPLICATE_KIND_LABELS } from "@/lib/duplicates";
import type { DuplicateCounts, DuplicateKind } from "@/lib/types";

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
			<ViewHeader
				bordered={false}
				icon={<Copy />}
				title="Duplicates"
				exitLabel="Exit duplicates"
				onExit={onExit}
			>
					<SegmentedControl
						label="Group kind"
						value={kind}
						onChange={onKindChange}
						options={KIND_OPTIONS.map((option) => {
							const count = option.value && counts?.[option.value];
							return {
								value: option.value,
								label: (
									<>
										{option.label}
										{typeof count === "number" && (
											<span data-testid="kind-count" className="opacity-70">
												({count})
											</span>
										)}
									</>
								),
							};
						})}
					/>
			</ViewHeader>
			{error && (
				<AlertBanner onDismiss={onDismissError}>{error}</AlertBanner>
			)}
		</div>
	);
}
