import react from '@vitejs/plugin-react'
import {defineConfig, type Connect} from 'vite'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

// Load Node handlers at request time. Vite's config bundler must not rewrite
// Pump's deliberate CommonJS compatibility boundary into file:// require().
function mount(server:{middlewares:Connect.Server}) {
  for (const name of ['rewards','intents','launch','metadata','coins','coin','catalog','near']) {
    server.middlewares.use('/api/'+name, async (req,res,next) => {
      try {
        const moduleUrl=pathToFileURL(resolve(process.cwd(),'api',name+'.js')).href
        const {default:handler}=await import(/* @vite-ignore */ moduleUrl)
        await handler(req,res)
      } catch(error) { next(error as Error) }
    })
  }
}
export default defineConfig({
  resolve:{alias:{buffer:'buffer/',util:'util/',process:'process/browser'}},
  plugins:[react(),{name:'intentpad-local-api',configureServer:mount,configurePreviewServer:mount}],
})
