import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@photobrain/api";

export const trpc = createTRPCReact<AppRouter>();
