export const VENUE='https://www.stonkfun.xyz';
export const NEAR_PAIR='3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG';
const mintPattern=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const metric=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0?x:null;
export function cleanToken(t,routes){
 if(!t||!mintPattern.test(t.mint)||t.quote?.mint!==NEAR_PAIR)return null;
 const symbol=String(t.symbol||'').slice(0,16),name=String(t.name||symbol).slice(0,80);
 const route=routes===null?'unknown':routes.some(r=>r.blockchain==='sol'&&r.contractAddress===t.mint)?'catalogued':'unlisted';
 return {mint:t.mint,name,symbol,pair:'NEAR',pairMint:NEAR_PAIR,status:t.status==='graduated'?'graduated':'bonding',source:'StonkFun',origin:'external',routeStatus:route,marketCap:metric(t.market?.marketCapUsd),volume:metric(t.market?.volume24hUsd),price:metric(t.market?.priceUsd),change:typeof t.market?.priceChange24h==='number'&&Number.isFinite(t.market.priceChange24h)?t.market.priceChange24h:null,progress:typeof t.graduationProgress==='number'&&Number.isFinite(t.graduationProgress)?Math.min(1,Math.max(0,t.graduationProgress)):null,createdAt:typeof t.createdAt==='string'&&!Number.isNaN(Date.parse(t.createdAt))?t.createdAt:null};
}
