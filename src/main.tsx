import './polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// After a deploy, a page loaded earlier asks for code chunks that no longer exist ("Failed to fetch dynamically
// imported module"). Reload once to pick up the new build; launch drafts survive in browser storage.
const reloadForNewBuild=()=>{try{const k='intentpad.chunk-reload',last=Number(sessionStorage.getItem(k)||0);if(Date.now()-last<60000)return;sessionStorage.setItem(k,String(Date.now()))}catch{return}window.location.reload()}
window.addEventListener('vite:preloadError',e=>{e.preventDefault();reloadForNewBuild()})
window.addEventListener('unhandledrejection',e=>{if(/Failed to fetch dynamically imported module|Importing a module script failed/.test(String(e.reason?.message||e.reason)))reloadForNewBuild()})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
