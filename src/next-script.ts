// <Redline />: the overlay's script tag for a Next app (D48). Put it in the root layout's <body>
// (App Router) or in pages/_document.tsx (Pages Router). It renders nothing outside development,
// so it can stay in the code; withRedline in next.config serves what it loads.
//
//   import { Redline } from '@umage.ai/redline/next/script'

import { createElement, type ReactElement } from 'react';

export function Redline(): ReactElement | null {
  if (process.env.NODE_ENV !== 'development') return null;
  return createElement('script', { type: 'module', src: '/__redline/client.js', async: true, 'data-redline-client': '' });
}

export default Redline;
