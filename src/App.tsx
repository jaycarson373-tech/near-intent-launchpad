import { useEffect, useMemo, useState } from 'react'
import './App.css'

type Asset = { defuse_asset_id: string; symbol: string; blockchain: string; price?: number; contract_address?: string }
const RPC = 'https://api-mng-console.chaindefuser.com/api/tokens'

function App() {
  const [assets, setAssets] = useState<Asset[]>([])
  const [assetState, setAssetState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [showCreate, setShowCreate] = useState(false)
  const [draft, setDraft] = useState({ name: '', ticker: '', goal: '25000', asset: '' })
  const [saved, setSaved] = useState(false)
  const [tab, setTab] = useState('Overview')

  useEffect(() => {
    let live = true
    fetch(RPC)
      .then(async r => { if (!r.ok) throw new Error('Asset directory unavailable'); return r.json() })
      .then(data => { if (!live) return; const list = data.items ?? data.tokens ?? []; setAssets(list); setAssetState('ready'); if (list[0]) setDraft(v => ({ ...v, asset: list[0].defuse_asset_id })) })
      .catch(() => { if (live) setAssetState('error') })
    return () => { live = false }
  }, [])

  const featuredAssets = useMemo(() => assets.filter(a => ['NEAR', 'WNEAR', 'USDC', 'USDT', 'ETH', 'SOL'].includes(a.symbol.toUpperCase())).slice(0, 5), [assets])
  const makeDraft = (event: React.FormEvent) => { event.preventDefault(); setSaved(true); setShowCreate(false) }

  return <div className="app-shell">
    <div className="ambient ambient-a"/><div className="ambient ambient-b"/>
    <header className="topbar">
      <a className="brand" href="#top"><span className="brand-mark">i</span><span>intent<span className="brand-light">launch</span></span><span className="brand-chain">NEAR</span></a>
      <nav>{['Overview', 'How it works', 'Docs'].map(item => <button className={tab === item ? 'nav-active' : ''} key={item} onClick={() => { setTab(item); if (item === 'How it works') document.getElementById('flow')?.scrollIntoView({ behavior: 'smooth' }); if (item === 'Docs') document.getElementById('docs')?.scrollIntoView({ behavior: 'smooth' }); if (item === 'Overview') window.scrollTo({ top: 0, behavior: 'smooth' }) }}>{item}</button>)}</nav>
      <button className="connect" onClick={() => alert('Wallet connection is not enabled in this preview. No signature or funds are requested.')}>Connect wallet <span>↗</span></button>
    </header>

    <main id="top">
      <section className="hero">
        <div className="hero-copy"><div className="eyebrow"><span className="live-dot"/> NEAR INTENTS • TOKEN LAUNCHES</div>
          <h1>One launch.<br/><em>Any supported asset.</em></h1>
          <p className="lede">Launch a NEAR token sale with a clean route for contributors across supported assets. Choose the sale, publish the terms, and let intent-based settlement handle the path.</p>
          <div className="hero-actions"><button className="primary" onClick={() => setShowCreate(true)}>Build a sale <span>↗</span></button><a className="secondary" href="#flow">See the flow <span>↓</span></a></div>
          <div className="trust-row"><span><b>01</b> Set sale terms</span><i/><span><b>02</b> Accept supported assets</span><i/><span><b>03</b> Settle transparently</span></div>
        </div>
        <div className="hero-panel">
          <div className="panel-head"><div><span className="panel-kicker">SALE BUILDER</span><h2>Intent-enabled launch</h2></div><span className="status-chip"><span className="green-dot"/> PREVIEW</span></div>
          <div className="route-card"><div className="route-from"><span className="route-icon">◎</span><span><small>CONTRIBUTE WITH</small><strong>{assetState === 'ready' ? 'Supported assets' : assetState === 'error' ? 'Asset list unavailable' : 'Loading asset list'}</strong></span></div><span className="route-arrow">⟶</span><div className="route-to"><span className="near-icon">N</span><span><small>SALE SETTLES TO</small><strong>NEAR token sale</strong></span></div></div>
          <div className="asset-label"><span>ASSET DIRECTORY</span><span className={assetState === 'ready' ? 'directory-ok' : ''}>{assetState === 'ready' ? 'LIVE DATA' : assetState === 'error' ? 'RETRY LATER' : 'CONNECTING'}</span></div>
          <div className="asset-pills">{featuredAssets.length ? featuredAssets.map(a => <span key={a.defuse_asset_id} className="asset-pill"><b>{a.symbol}</b><small>{a.blockchain}</small></span>) : <span className="asset-empty">{assetState === 'error' ? 'Could not load the asset directory.' : 'Reading the supported asset directory…'}</span>}</div>
          <div className="panel-foot"><span className="lock">◈</span><span>Quote first. Review the route. Sign only when the final terms are visible.</span></div>
          <div className="panel-orbit orbit-one"/><div className="panel-orbit orbit-two"/>
        </div>
      </section>

      <section className="ticker-strip"><div><span>SALE TYPE</span><b>Fixed price or auction</b></div><div><span>SETTLEMENT</span><b>Intent-routed</b></div><div><span>ASSET SUPPORT</span><b>{assetState === 'ready' ? `${assets.length} directory assets` : 'NEAR Intents directory'}</b></div><div><span>STATUS</span><b className="text-amber">Preview build</b></div></section>

      <section className="section" id="flow"><div className="section-heading"><div><span className="eyebrow">THE LAUNCH FLOW</span><h2>Clear terms. Better routes.</h2></div><p>The sale contract defines allocation and settlement. NEAR Intents can route supported assets into the outcome a participant chooses.</p></div>
        <div className="steps"><article><span className="step-no">01</span><div className="step-icon">⌘</div><h3>Configure</h3><p>Set the token, sale format, price, cap, allocation rules, and close time before opening the sale.</p><span className="step-tag">CREATOR SETS THE RULES</span></article><article><span className="step-no">02</span><div className="step-icon">⇄</div><h3>Choose an asset</h3><p>Participants select from the supported asset directory and review the quoted route and minimum received.</p><span className="step-tag">QUOTE BEFORE SIGNING</span></article><article><span className="step-no">03</span><div className="step-icon">◌</div><h3>Settle & claim</h3><p>Track the sale state, settlement receipts, and claimable allocation in one auditable launch page.</p><span className="step-tag">STATUS VISIBLE ON SITE</span></article></div>
      </section>

      <section className="sale-empty"><div className="sale-title"><div><span className="eyebrow">OPEN SALES</span><h2>First sale starts here.</h2></div><span className="empty-badge">NO LIVE SALES</span></div><div className="empty-card"><div className="empty-symbol">＋</div><h3>Launch the first project</h3><p>Sale listings will appear here after a creator publishes verified on-chain terms.</p><button className="text-button" onClick={() => setShowCreate(true)}>Create a sale draft <span>↗</span></button></div></section>

      <section className="docs-section" id="docs"><div className="docs-main"><span className="eyebrow">BUILT AROUND INTENTS</span><h2>Route choice belongs to the buyer.</h2><p>Intent-based settlement lets a participant specify the asset outcome they want. Solvers compete to fulfill the request; a quote is shown before the wallet signs. The sale contract still needs to enforce the project’s allocation and refund rules.</p><a href="https://docs.near.org/tutorials/intents/introduction" target="_blank" rel="noreferrer">Read NEAR Intents integration docs <span>↗</span></a></div><div className="docs-side"><div className="docs-row"><span>Asset directory</span><b>{assetState === 'ready' ? 'Connected' : assetState === 'error' ? 'Unavailable' : 'Loading'}</b></div><div className="docs-row"><span>Sale contracts</span><b>Not deployed</b></div><div className="docs-row"><span>Wallet signing</span><b>Not enabled</b></div><div className="docs-row"><span>Money movement</span><b>Disabled</b></div></div></section>
    </main>
    <footer><a className="brand" href="#top"><span className="brand-mark">i</span><span>intent<span className="brand-light">launch</span></span></a><span>Independent project preview • Not affiliated with NEAR Foundation</span><span>© 2026 INTENT LAUNCH</span></footer>

    {showCreate && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setShowCreate(false) }}><form className="create-modal" onSubmit={makeDraft}><button type="button" className="modal-close" onClick={() => setShowCreate(false)}>×</button><span className="eyebrow">LOCAL DRAFT ONLY</span><h2>Configure a launch</h2><p>This saves a draft in this browser. It does not deploy a token or move funds.</p><label>Project name<input required maxLength={40} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Example Project"/></label><label>Ticker<input required maxLength={10} value={draft.ticker} onChange={e => setDraft({ ...draft, ticker: e.target.value.toUpperCase() })} placeholder="TOKEN"/></label><div className="form-grid"><label>Raise target<input type="number" min="1" value={draft.goal} onChange={e => setDraft({ ...draft, goal: e.target.value })}/></label><label>Sale asset<select value={draft.asset} onChange={e => setDraft({ ...draft, asset: e.target.value })}>{assets.map(a => <option key={a.defuse_asset_id} value={a.defuse_asset_id}>{a.symbol} · {a.blockchain}</option>)}</select></label></div><button className="primary modal-submit" type="submit">Save local draft <span>↗</span></button></form></div>}
    {saved && <div className="toast" role="status"><span>✓</span> Draft saved in this browser <button onClick={() => setSaved(false)}>×</button></div>}
  </div>
}

export default App
