import pulse from './api/pulse.js';
import rewards from './api/rewards.js';
import intents from './api/intents.js';
import launch from './api/launch.js';
import metadata from './api/metadata.js';
import coins from './api/coins.js';
import coin from './api/coin.js';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import near from './api/near.js';
import catalog from './api/catalog.js';
const root=fileURLToPath(new URL('./dist/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.webp':'image/webp','.woff2':'font/woff2'};
export function createServer(staticRootInput=root){const staticRoot=resolve(staticRootInput);return http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
 const path=new URL(req.url||'/','http://localhost').pathname;
 if(path==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({service:'intent-pad',healthy:true}));return;}
 if(path==='/api/pulse')return pulse(req,res);if(path==='/api/rewards')return rewards(req,res);if(path==='/api/intents')return intents(req,res);if(path==='/api/launch')return launch(req,res);if(path==='/api/metadata')return metadata(req,res);if(path==='/api/coins')return coins(req,res);if(path==='/api/coin')return coin(req,res);if(path==='/api/near')return near(req,res);if(path==='/api/catalog')return catalog(req,res);
 if(path.startsWith('/api/')){res.writeHead(404);res.end('Not found');return;}
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD'});res.end('Method not allowed');return;}
 try{const decoded=decodeURIComponent(path),file=resolve(staticRoot,'.'+decoded+(decoded.endsWith('/')?'index.html':''));const rel=relative(staticRoot,file);if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)){res.writeHead(400);res.end('Invalid path');return;}
 let data,served=file;try{data=await readFile(file)}catch(error){if(extname(file))throw error;served=resolve(staticRoot,'index.html');data=await readFile(served)}
 res.setHeader('Content-Type',types[extname(served)]||'application/octet-stream');res.setHeader('Cache-Control',path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache');res.end(req.method==='HEAD'?undefined:data);
 }catch{res.writeHead(404);res.end('Not found');}
})}
if(process.argv[1]===fileURLToPath(import.meta.url)){createServer().listen(Number(process.env.PORT||8080),'0.0.0.0');if(process.env.INTENT_REWARDS_ENABLED==='1')import('./worker/run.mjs').then(m=>m.startRewardsWorker()).catch(()=>console.error('Intent rewards worker could not start.'));}
