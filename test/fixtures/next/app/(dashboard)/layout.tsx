import type { ReactNode } from 'react';

// A route group's layout (a Server Component) between the root layout and the page.
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <div className="dashboard">{children}</div>;
}
