import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

if (typeof window !== 'undefined') {
  const originalBtoa = window.btoa;
  window.btoa = function(str: string) {
    try {
      return originalBtoa(str);
    } catch (e) {
      return originalBtoa(unescape(encodeURIComponent(str)));
    }
  };
}

import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
