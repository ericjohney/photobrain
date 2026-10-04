import { realtimeMiddleware } from "@inngest/realtime/middleware";
import { EventSchemas, Inngest } from "inngest";

type PhotoEvents = {
	"photos/scan.requested": {
		data: {
			directory: string;
			thumbnailsDir: string;
			jobId: string;
			force?: boolean;
		};
	};
	"photos/embeddings.requested": {
		data: {
			photoIds: number[];
			thumbnailsDir: string;
			jobId: string;
		};
	};
	"photos/tags.requested": {
		data: Record<string, never>;
	};
	"photos/quality.requested": {
		data: Record<string, never>;
	};
	"photos/places.requested": {
		data: Record<string, never>;
	};
	"photos/events.requested": {
		data: Record<string, never>;
	};
	"photos/faces.requested": {
		data: Record<string, never>;
	};
};

export const inngest = new Inngest({
	id: "photobrain",
	schemas: new EventSchemas().fromRecord<PhotoEvents>(),
	middleware: [realtimeMiddleware()],
});
