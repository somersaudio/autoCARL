// AUTOcarl web entry — install the browser Api shim FIRST (it assigns
// window.api before any renderer code can look for it), then mount the
// desktop renderer exactly as src/renderer/main.tsx does.
import './api-shim';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../renderer/App';
import '../renderer/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
