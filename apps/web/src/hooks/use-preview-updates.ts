import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";

/** Background RAW publication changes thumbnail cache tokens, independently of scan progress. */
export function usePreviewUpdates() {
	// Zero is the migration baseline; avoid duplicating the initial catalog load.
	const previous = useRef(0);
	const utils = trpc.useUtils();
	const status = trpc.previewRevision.useQuery(undefined, {
		refetchInterval: 5000,
		refetchIntervalInBackground: false,
	});
	useEffect(() => {
		if (status.data && previous.current !== status.data.revision) {
			previous.current = status.data.revision;
			void utils.invalidate();
		}
	}, [status.data, utils]);
}
