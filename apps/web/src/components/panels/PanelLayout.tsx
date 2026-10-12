import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PanelLayoutProps {
	leftPanel?: ReactNode;
	rightPanel?: ReactNode;
	filmstrip?: ReactNode;
	/** Status bar across the bottom of the window. */
	footer?: ReactNode;
	/** Chrome above the content (breadcrumbs, title, filters), inside the center column. */
	header?: ReactNode;
	children: ReactNode;
	leftPanelVisible?: boolean;
	/** Icon rail instead of the full sidebar. */
	leftPanelCollapsed?: boolean;
	rightPanelVisible?: boolean;
	filmstripVisible?: boolean;
}

export function PanelLayout({
	leftPanel,
	rightPanel,
	filmstrip,
	footer,
	header,
	children,
	leftPanelVisible = true,
	leftPanelCollapsed = false,
	rightPanelVisible = true,
	filmstripVisible = true,
}: PanelLayoutProps) {
	return (
		<div className="flex h-screen w-full flex-col overflow-hidden bg-background">
			<div className="flex min-h-0 flex-1 overflow-hidden">
				{/* Left panel: sidebar or icon rail */}
				{leftPanel && leftPanelVisible && (
					<div
						data-testid="left-panel"
						data-collapsed={leftPanelCollapsed}
						className={cn(
							"flex-shrink-0 overflow-hidden border-r border-border bg-panel",
							leftPanelCollapsed ? "w-14" : "w-64",
						)}
					>
						{leftPanel}
					</div>
				)}

				{/* Center area (header + content + filmstrip) */}
				<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
					{header && <div className="flex-shrink-0">{header}</div>}
					<div className="min-h-0 flex-1 overflow-hidden">{children}</div>
					{filmstrip && filmstripVisible && (
						<div className="h-24 flex-shrink-0 overflow-hidden border-t border-border bg-panel">
							{filmstrip}
						</div>
					)}
				</div>

				{/* Right panel */}
				{rightPanel && rightPanelVisible && (
					<div
						data-testid="right-panel"
						className="w-72 flex-shrink-0 overflow-hidden border-l border-border bg-panel"
					>
						{rightPanel}
					</div>
				)}
			</div>
			{footer && (
				<div className="flex-shrink-0 border-t border-border bg-panel">
					{footer}
				</div>
			)}
		</div>
	);
}

// Panel section component for consistent styling
interface PanelSectionProps {
	title: string;
	children: ReactNode;
	defaultOpen?: boolean;
	actions?: ReactNode;
	className?: string;
}

export function PanelSection({
	title,
	children,
	actions,
	className,
}: PanelSectionProps) {
	return (
		<div className={cn("panel-section", className)}>
			<div className="panel-header">
				<span>{title}</span>
				{actions}
			</div>
			{children}
		</div>
	);
}
