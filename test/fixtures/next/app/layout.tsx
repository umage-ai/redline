import type { ReactNode } from 'react';
import { Redline } from '@umage.ai/redline/next/script';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Redline />
      </body>
    </html>
  );
}
