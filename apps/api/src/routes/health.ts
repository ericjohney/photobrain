import { Hono } from "hono";

const router = new Hono();

router.get("/", (c) => {
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default router;
