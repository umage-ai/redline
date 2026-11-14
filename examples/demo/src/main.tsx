import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { DriversPage } from './drivers.tsx';
import { usePath } from './nav.ts';

function Root() {
  const path = usePath();
  return path === '/drivers' ? <DriversPage /> : <App />;
}

createRoot(document.getElementById('root')!).render(<Root />);
