import { useEffect, useState } from "react";
import { config } from "@/lib/config";

/** Each activation develops afresh; cancellation releases the temporary image. */
export function useRawDevelopment(photoId: number | undefined) {
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [result, setResult] = useState<{
		id: number;
		url?: string;
		error?: string;
	} | null>(null);
	const enabled = photoId !== undefined && selectedId === photoId;
	useEffect(() => {
		if (!enabled || photoId === undefined) return;
		const id = photoId;
		const controller = new AbortController();
		let objectUrl: string | undefined;
		setResult(null);
		async function load() {
			try {
				const response = await fetch(
					`${config.apiUrl}/api/photos/${photoId}/developed`,
					{
						signal: controller.signal,
						cache: "no-store",
					},
				);
				if (!response.ok) {
					const body = await response.json().catch(() => null);
					throw new Error(body?.error ?? "Failed to develop RAW");
				}
				const blob = await response.blob();
				if (controller.signal.aborted) return;
				objectUrl = URL.createObjectURL(blob);
				const image = new Image();
				image.src = objectUrl;
				await image.decode();
				if (!controller.signal.aborted) setResult({ id, url: objectUrl });
			} catch (error) {
				if (!controller.signal.aborted)
					setResult({
						id,
						error:
							error instanceof Error ? error.message : "Failed to develop RAW",
					});
			}
		}
		void load();
		return () => {
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [enabled, photoId]);
	// Moving to another photo resets the option, even when navigating back.
	useEffect(() => {
		if (photoId !== selectedId) setSelectedId(null);
	}, [photoId, selectedId]);
	const current = enabled && result?.id === photoId ? result : null;
	return {
		enabled,
		url: current?.url,
		error: current?.error,
		loading: enabled && !current,
		toggle: () => {
			setResult(null);
			setSelectedId(enabled ? null : (photoId ?? null));
		},
	};
}
