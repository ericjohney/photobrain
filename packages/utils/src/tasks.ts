import { z } from "zod";

/**
 * Task types for workflow processing
 * Workflow names match these task types exactly
 */
export const TaskTypeSchema = z.enum(["scan", "phash", "embedding"]);
export type TaskType = z.infer<typeof TaskTypeSchema>;
export const TASK_TYPES = TaskTypeSchema.options;

/**
 * Status for individual task items
 */
export const TaskItemStatusSchema = z.enum(["pending", "completed", "failed"]);
export type TaskItemStatus = z.infer<typeof TaskItemStatusSchema>;

/**
 * Individual task item (e.g., a single photo being processed)
 */
export const TaskItemSchema = z.object({
	id: z.number(),
	path: z.string().optional(),
	status: TaskItemStatusSchema,
	error: z.string().optional(),
});
export type TaskItem = z.infer<typeof TaskItemSchema>;

/**
 * Progress state for a workflow/task
 */
export const TaskProgressSchema = z.object({
	taskType: TaskTypeSchema,
	current: z.number(),
	total: z.number(),
	items: z.array(TaskItemSchema),
});
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

/**
 * Event emitted via subscription when a task item completes
 */
export const TaskEventSchema = z.object({
	taskType: TaskTypeSchema,
	item: TaskItemSchema,
	progress: z.object({
		current: z.number(),
		total: z.number(),
	}),
	workflowId: z.string(),
});
export type TaskEvent = z.infer<typeof TaskEventSchema>;

/**
 * Create an empty TaskProgress for a given task type
 */
export function createEmptyProgress(taskType: TaskType): TaskProgress {
	return {
		taskType,
		current: 0,
		total: 0,
		items: [],
	};
}
