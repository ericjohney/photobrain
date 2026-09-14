import { NativeExecutor } from "../../services/native-executor";

const executor = new NativeExecutor(
	new URL("./native-worker.ts", import.meta.url),
);
await executor.run("discoverPhotos", "warmup");
if (process.argv[2] === "close") {
	const results = Promise.allSettled([
		executor.run("discoverPhotos", "busy"),
		executor.run("discoverPhotos", "queued"),
	]);
	await Bun.sleep(10);
	executor.close();
	if ((await results).some((result) => result.status !== "rejected"))
		process.exitCode = 1;
}
// No process.exit(): a leaked/ref'ed worker would keep this subprocess alive.
console.log("finished");
