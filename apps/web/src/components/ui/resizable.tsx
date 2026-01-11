"use client";

import { GripVertical } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type GroupProps = ComponentProps<typeof Group>;

interface ResizablePanelGroupProps extends Omit<GroupProps, "orientation"> {
	direction?: "horizontal" | "vertical";
	defaultLayout?: { [panelId: string]: number };
}

const ResizablePanelGroup = ({
	className,
	direction = "horizontal",
	defaultLayout,
	...props
}: ResizablePanelGroupProps) => (
	<Group
		orientation={direction}
		defaultLayout={defaultLayout}
		className={cn(
			"flex h-full w-full",
			direction === "vertical" && "flex-col",
			className,
		)}
		{...props}
	/>
);

const ResizablePanel = Panel;

const ResizableHandle = ({
	withHandle,
	className,
	...props
}: ComponentProps<typeof Separator> & {
	withHandle?: boolean;
}) => (
	<Separator
		className={cn(
			"relative flex items-center justify-center bg-border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
			"data-[orientation=horizontal]:h-full data-[orientation=horizontal]:w-px",
			"data-[orientation=vertical]:h-px data-[orientation=vertical]:w-full",
			"hover:bg-primary/50",
			className,
		)}
		{...props}
	>
		{withHandle && (
			<div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
				<GripVertical className="h-2.5 w-2.5" />
			</div>
		)}
	</Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
