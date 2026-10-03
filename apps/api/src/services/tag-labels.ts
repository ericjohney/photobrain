import { clipTextEmbedding } from "@photobrain/image-processing";
import { createTagLabelMatrix, type TagLabelMatrix } from "./photo-tagging";
import { TAG_VOCABULARY } from "./tag-vocabulary";

let vocabularyMatrix: TagLabelMatrix | undefined;

/**
 * Embeds every vocabulary prompt once per process with the CLIP text encoder
 * (80 labels: ~0.3-0.9 s warm, plus ~0.15-0.3 s text-model load). Called only
 * from tagging paths, never on import or inside a SQLite transaction, so list
 * and search endpoints never wait for it. Failures are not memoized.
 */
export function loadTagLabelMatrix(): TagLabelMatrix {
	vocabularyMatrix ??= createTagLabelMatrix(
		TAG_VOCABULARY.map(({ tag, prompt }) => ({
			tag,
			vector: clipTextEmbedding(prompt),
		})),
	);
	return vocabularyMatrix;
}
