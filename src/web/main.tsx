// File: src/web/main.tsx
import React, { lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { LazyBoundary } from './components/LazyBoundary.js';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './index.css';
import './styles/semantic-utilities.css';
import './styles/markdown.css';
import './styles/responsive-utilities.css';

const DeviceApproval = lazy(() => import('./components/DeviceApproval.js').then((module) => ({ default: module.DeviceApproval })));
const McpConsent = lazy(() => import('./components/McpConsent.js').then((module) => ({ default: module.McpConsent })));

// /device (MUS-28's login approval page) and /mcp/authorize (MUS-29's
// consent screen) are standalone screens outside the /projects/:id app
// shell and its custom router — routed here rather than threading them
// through App's state.
const path = window.location.pathname;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {path === '/device' ? (
      <LazyBoundary label="Device Login" resetKey="device-login">
        <DeviceApproval />
      </LazyBoundary>
    ) : path === '/mcp/authorize' ? (
      <LazyBoundary label="MCP Authorization" resetKey="mcp-authorization">
        <McpConsent />
      </LazyBoundary>
    ) : <App />}
  </React.StrictMode>
);
