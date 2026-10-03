import { Tag } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatTagName } from "@/lib/utils";

/**
 * Metadata-panel row: the active photo's auto tags (highest score first) as
 * chips; clicking one filters the library by that tag.
 */
export function PhotoTags({
	photoId,
	onSelect,
}: {
	photoId: number;
	onSelect: (tag: string) => void;
}) {
	const tagsQuery = trpc.photoTags.useQuery({ photoId });
	const tags = tagsQuery.data?.tags;

	return (
		<div data-testid="photo-tags" className="border-b border-border px-3 py-2">
			<span className="metadata-label flex items-center gap-1.5 text-xs">
				<Tag className="h-3.5 w-3.5" />
				Tags
			</span>
			{tags && tags.length > 0 && (
				<ul aria-label="Photo tags" className="mt-1.5 flex flex-wrap gap-1">
					{tags.map(({ tag }) => (
						<li key={tag}>
							<button
								type="button"
								title={`Show photos tagged ${formatTagName(tag)}`}
								onClick={() => onSelect(tag)}
								className="rounded-full bg-primary/15 px-2 py-0.5 text-2xs text-primary hover:bg-primary/25"
							>
								{formatTagName(tag)}
							</button>
						</li>
					))}
				</ul>
			)}
			{tags?.length === 0 && (
				<p className="mt-1 text-2xs text-muted-foreground">No tags yet</p>
			)}
			{tagsQuery.error && (
				<p role="alert" className="mt-1 text-2xs text-destructive">
					{tagsQuery.error.message}
				</p>
			)}
		</div>
	);
}
