import { useEffect, useState } from "react";
import { getDevelopedUrl } from "@/lib/thumbnails";
import type { PhotoMetadata } from "@/lib/types";

const STORAGE_KEY = "photobrain-loupe-developed";
/** 503 `DEVELOP_BUSY` retries before giving up. */
const MAX_BUSY_RETRIES = 5;

export type DevelopedRaw =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "ready"; url: string; width: number; height: number }
	| { status: "error"; message: string };

/**
 * The RAW to develop for a loupe photo: the photo itself when it is a
 * converted RAW, or the RAW partner of a stacked RAW+JPEG pair; else null.
 */
export function developableRawId(
	photo: Pick<
		PhotoMetadata,
		"id" | "isRaw" | "rawStatus" | "mediaType" | "pairedPhotoId"
	> | null,
): number | null {
	if (!photo || photo.mediaType === "video") return null;
	if (photo.isRaw) return photo.rawStatus === "converted" ? photo.id : null;
	return photo.pairedPhotoId;
}

/** The persisted loupe preference: show the developed RAW instead of the embedded preview. */
export function useDevelopedPreference() {
	const [enabled, setEnabled] = useState(() => {
		try {
			return localStorage.getItem(STORAGE_KEY) === "1";
		} catch {
			return false;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
		} catch {
			// Ignore storage errors
		}
	}, [enabled]);
	return [enabled, setEnabled] as const;
}

async function errorMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as {
			error?: { code?: string; message?: string };
		};
		if (body.error?.code === "DEVELOP_UNSUPPORTED")
			return "Not available for this camera";
		if (body.error?.message) return body.error.message;
	} catch {
		// Not JSON
	}
	return `Request failed (${response.status})`;
}

/**
 * Fetches the developed render of `rawId` (null = nothing), keeping it as an
 * object URL until the photo changes. Not cached: every visit renders again.
 * A busy renderer (503 with `Retry-After`) is retried a few times.
 */
export function useDevelopedRaw(rawId: number | null): DevelopedRaw {
	const [tagged, setTagged] = useState<{
		id: number | null;
		state: DevelopedRaw;
	}>({ id: null, state: { status: "idle" } });

	useEffect(() => {
		if (rawId === null) return;
		const setState = (state: DevelopedRaw) => setTagged({ id: rawId, state });
		const controller = new AbortController();
		let objectUrl: string | null = null;
		setState({ status: "loading" });

		const sleep = (ms: number) =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, ms);
				controller.signal.addEventListener("abort", () => {
					clearTimeout(timer);
					reject(controller.signal.reason);
				});
			});

		(async () => {
			for (let attempt = 0; ; attempt++) {
				const response = await fetch(getDevelopedUrl(rawId), {
					signal: controller.signal,
				});
				if (response.status === 503 && attempt < MAX_BUSY_RETRIES) {
					const seconds = Number(response.headers.get("Retry-After")) || 1;
					await sleep(seconds * 1000);
					continue;
				}
				if (!response.ok) {
					setState({ status: "error", message: await errorMessage(response) });
					return;
				}
				const width = Number(response.headers.get("X-Developed-Width")) || 0;
				const height = Number(response.headers.get("X-Developed-Height")) || 0;
				const blob = await response.blob();
				if (controller.signal.aborted) return;
				objectUrl = URL.createObjectURL(blob);
				setState({ status: "ready", url: objectUrl, width, height });
				return;
			}
		})().catch((error: unknown) => {
			if (controller.signal.aborted) return;
			setState({
				status: "error",
				message: error instanceof Error ? error.message : "Network error",
			});
		});

		return () => {
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
			// Forget the revoked URL, so re-enabling renders afresh.
			setTagged({ id: null, state: { status: "idle" } });
		};
	}, [rawId]);

	// A state from another photo (before the effect re-runs) is never shown.
	if (rawId === null) return { status: "idle" };
	return tagged.id === rawId ? tagged.state : { status: "loading" };
}
