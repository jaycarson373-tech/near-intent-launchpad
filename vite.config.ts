import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import catalog from './api/catalog.js'
import near from './api/near.js'
export default defineConfig({
  resolve:{alias:{buffer:'buffer/',util:'util/',process:'process/browser'}},
  plugins: [react(), {name:'intentpad-local-api',configureServer(server){server.middlewares.use('/api/catalog',(req,res)=>{void catalog(req,res)});server.middlewares.use('/api/near',(req,res)=>{void near(req,res)})},configurePreviewServer(server){server.middlewares.use('/api/catalog',(req,res)=>{void catalog(req,res)});server.middlewares.use('/api/near',(req,res)=>{void near(req,res)})}}],
})
