import type { ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";

interface LayoutProps {
	title?: string;
	actions?: ReactNode;
	children: ReactNode;
}

export function Layout({ title, actions, children }: LayoutProps) {
	return (
		<div className="flex-1 flex flex-col">
			<header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
				<div className="flex items-center gap-2 px-4 py-3">
					<SidebarTrigger />
					{title && <h1 className="text-lg font-semibold">{title}</h1>}
					{actions && (
						<div className="flex-1 flex items-center gap-2 justify-end">
							{actions}
						</div>
					)}
				</div>
			</header>

			<main className="flex-1 p-6">{children}</main>
		</div>
	);
}
