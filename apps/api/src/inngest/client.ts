import { realtimeMiddleware } from "@inngest/realtime/middleware";
import { EventSchemas, Inngest } from "inngest";

type PhotoEvents = {
	"photos/scan.requested": {
		data: {
			directory: string;
			thumbnailsDir: string;
			jobId: string;
		};
	};
	"photos/embeddings.requested": {
		data: {
			photoIds: number[];
			thumbnailsDir: string;
			jobId: string;
		};
	};
};

export const inngest = new Inngest({
	id: "photobrain",
	schemas: new EventSchemas().fromRecord<PhotoEvents>(),
	middleware: [realtimeMiddleware()],
});
