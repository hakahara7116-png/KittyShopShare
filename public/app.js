// Kitty frontend: talks only to /api. Payments happen on the provider's hosted checkout.
'use strict';
const CFG = window.KITTY_CONFIG || { auth: { mode: 'dev' } };
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = c => '$' + (Math.max(0, Math.round(c || 0)) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const when = d => d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const eachOf = (total, n) => Math.ceil(total / Math.max(1, n));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CATS = ['Groceries', 'Bulk & household', 'Meat & seafood', 'Electronics', 'Home & garden', 'Other'];
const DLABEL = { doordash: 'DoorDash', uber: 'Uber', pickup: 'In-store pickup' };

// ---------------- auth ----------------
const Auth = {
  mode: CFG.auth.mode === 'dev' ? 'demo' : CFG.auth.mode, client: null, user: null,
  async init() {
    if (this.mode === 'auth0') {
      if (!window.auth0) throw new Error('auth0-sdk');
      this.client = await window.auth0.createAuth0Client({
        domain: CFG.auth.domain, clientId: CFG.auth.clientId, cacheLocation: 'localstorage', useRefreshTokens: true,
        authorizationParams: { audience: CFG.auth.audience, redirect_uri: location.origin },
      });
      const qs = new URLSearchParams(location.search);
      if (qs.has('code') && qs.has('state')) {
        const { appState } = await this.client.handleRedirectCallback();
        history.replaceState({}, '', (appState && appState.returnTo) || '/');
      }
      if (await this.client.isAuthenticated()) {
        this.user = await this.client.getUser();
        api('PUT', '/me', { name: this.user.name || this.user.email }).catch(() => {});
      }
    } else {
      const n = localStorage.getItem('kitty-dev-user');
      if (n) this.user = { name: n };
    }
  },
  async headers() {
    if (!this.user) return {};
    if (this.mode === 'auth0') return { authorization: 'Bearer ' + await this.client.getTokenSilently() };
    return { 'x-dev-user': this.user.name };
  },
  login() {
    if (this.mode === 'auth0') return this.client.loginWithRedirect({ appState: { returnTo: location.pathname + location.search + location.hash } });
    devSignIn();
  },
  async logout() {
    if (this.mode === 'auth0') return this.client.logout({ logoutParams: { returnTo: location.origin } });
    localStorage.removeItem('kitty-dev-user'); this.user = null; S.me = null; render(); renderAuth();
  },
};
async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', ...(await Auth.headers()) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Request failed.'); e.status = r.status; e.similar = d.similar; throw e; }
  return d;
}

// ---------------- state ----------------
const S = { health: null, view: 'shop', catalog: null, near: null, mine: null, me: null, orders: null, q: '', ret: null, loc: null, radius: Number(localStorage.getItem('kitty-radius')) || 10, inbox: null, similar: [] };
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3800); }
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r ?? true; }
  catch (e) { if (e.status === 401) { toast('Sign in to continue.'); Auth.login(); } else toast(e.message); return false; }
}

async function load(view = S.view) {
  try {
    if (view === 'shop') S.catalog = await api('GET', '/catalog');
    if (!Auth.user) return;
    if (!S.me || view === 'vendor') { S.me = await api('GET', '/me'); if (S.me.location?.lat != null) S.loc = S.me.location; }
    if ((view === 'groups' || view === 'shop') && S.loc) S.near = (await api('GET', `/group-orders?radius=${S.radius}`)).groups;
    if (view === 'mine' || view === 'shop') S.mine = (await api('GET', '/group-orders?scope=mine')).groups;
    if (view === 'vendor') S.orders = S.me.vendor ? (await api('GET', '/vendor/orders')).groups : [];
    S.inbox = await api('GET', '/notifications');
  } catch (e) { if (e.status !== 401) toast(e.message); }
}
async function go(view) {
  S.view = view; history.replaceState({}, '', '#' + view);
  render(); await load(view); render();
}

// ---------------- rendering ----------------
function arc(c, r, a0, a1) {
  const p = a => [c + r * Math.cos(a * Math.PI / 180), c + r * Math.sin(a * Math.PI / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function ring(seats, filled, paid, size = 104) {
  const c = size / 2, r = c - 8, gap = Math.min(16, 160 / seats); let out = '';
  for (let i = 0; i < seats; i++) {
    const a0 = i * 360 / seats - 90 + gap / 2, a1 = (i + 1) * 360 / seats - 90 - gap / 2;
    out += `<path class="${i < paid ? 'seg paid' : i < filled ? 'seg on' : 'seg'}" d="${arc(c, r, a0, a1)}"/>`;
  }
  return `<svg viewBox="0 0 ${size} ${size}" width="100%" height="100%" aria-hidden="true">${out}</svg>`;
}
const chip = (label, tone) => `<span class="chip-s ${tone || ''}">${esc(label)}</span>`;
const GROUP = { open: ['Forming', 'info'], authorizing: ['Authorizing carts', 'warn'], capturing: ['Capturing', 'warn'], captured: ['Captured', 'good'], compensating: ['Undoing captures', 'bad'], cancelled: ['Cancelled', ''], complete: ['Complete', 'good'] };
const CART = { pending: ['Not authorized', 'warn'], authorized: ['Authorized', 'good'], captured: ['Captured', 'info'], voided: ['Hold released', ''], refunded: ['Refunded', 'bad'], cancelled: ['Cancelled', ''] };
const DEL = { requested: 'Courier requested', ready_for_pickup: 'Ready for pickup', picked_up: 'Picked up', delivered: 'Delivered', failed: 'Delivery failed', cancelled: 'Delivery cancelled' };

function renderAuth() {
  $('#authbar').innerHTML = Auth.user
    ? `<span class="who">${esc(Auth.user.name || Auth.user.email || 'Signed in')}</span><button class="btn ghost small" data-act="logout">Sign out</button>`
    : `<button class="btn small" data-act="login">Sign in</button>`;
}
function render() {
  document.querySelectorAll('nav.tabs button').forEach(b => b.dataset.view === S.view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  const todo = (S.mine || []).filter(g => g.status === 'authorizing' && g.carts.some(c => c.isMine && c.status === 'pending')).length;
  const tc = $('#todo-count'); tc.hidden = !todo; tc.textContent = todo;
  const nearOpen = (S.near || []).filter(g => !g.carts.some(c => c.isMine)).length;
  const nc = $('#near-count'); nc.hidden = !nearOpen; nc.textContent = nearOpen;
  $('#bell').hidden = !Auth.user;
  const unread = S.inbox?.unread || 0, bc = $('#bell-count'); bc.hidden = !unread; bc.textContent = unread;
  const v = $('#view');
  if (S.health && !S.health.ok) { v.innerHTML = setupPanel(); return; }
  if (S.ret) { v.innerHTML = returnPanel(); return; }
  if (S.view !== 'shop' && !Auth.user) {
    v.innerHTML = `<div class="empty signin"><h3>Sign in to continue</h3><p>Group buys, checkout and shop tools need an account so we know whose cart is whose.</p><button class="btn" data-act="login">Sign in</button></div>`;
    return;
  }
  v.innerHTML = ({ shop: viewShop, groups: viewNear, mine: viewMine, vendor: viewVendor })[S.view]();
}

function viewShop() {
  const vendors = S.catalog ? S.catalog.vendors : null;
  const items = (vendors || []).flatMap(v => v.items.map(i => ({ ...i, vendor: v })));
  const q = S.q.trim().toLowerCase();
  const list = items.filter(i => !q || (i.name + ' ' + i.vendor.name).toLowerCase().includes(q));
  return `<div class="hero"><div><h1>Buy it together. Pay an even share.</h1>
      <p>Start a group buy on anything a local shop lists. Each shopper checks out on the shop’s own payment page, cards are only charged once everyone’s is authorized, and each shopper gets their own portion.</p></div></div>
    <div class="toolbar"><label class="search"><input id="q" type="search" placeholder="Search items or shops" value="${esc(S.q)}" aria-label="Search items or shops"></label></div>
    ${!vendors ? '<p class="note">Loading shops…</p>' : !items.length ? `<div class="empty"><h3>No shops are selling yet</h3><p>Shops connect a payment account under For shops, then list their items here.</p></div>`
      : `<div class="grid">${list.map(i => `<article class="item">
        <div class="tile" aria-hidden="true">${esc(i.emoji || '📦')}</div>
        <div><h3>${esc(i.name)}</h3><div class="shop">${esc(i.vendor.name)}${i.vendor.area ? ', ' + esc(i.vendor.area) : ''}</div></div>
        ${i.description ? `<p class="desc">${esc(i.description)}</p>` : ''}
        <div><div class="price">${money(i.price)}</div><div class="from">${i.stock > 0 ? `${i.stock} in stock` : '<span class="low">Out of stock</span>'}</div></div>
        <div class="tags"><span class="tag">Pays via ${esc(i.vendor.provider)}</span>${['doordash', 'uber', 'pickup'].filter(k => i.vendor.delivery[k]?.on).map(k => `<span class="tag">${DLABEL[k]}${i.vendor.delivery[k].fee ? ' ' + money(i.vendor.delivery[k].fee) : ''}</span>`).join('')}</div>
        <div class="actions">${(() => { const k = (S.near || []).filter(g => g.itemId === i.id && !g.carts.some(c => c.isMine)).length;
          return k ? `<button class="linkish" data-view="groups">${k === 1 ? 'A group is forming near you' : k + ' groups forming near you'}. Join instead</button>` : ''; })()}
          <button class="btn" data-act="start" data-vendor="${esc(i.vendor.id)}" data-item="${esc(i.id)}" ${i.stock > 0 ? '' : 'disabled'}>Start a group buy</button></div>
      </article>`).join('')}</div>`}`;
}

function groupStatus(g) {
  const n = g.carts.length, auth = g.carts.filter(c => ['authorized', 'captured'].includes(c.status)).length;
  switch (g.status) {
    case 'open': return `${n} of ${g.seats} spots filled.`;
    case 'authorizing': return `${auth} of ${n} carts authorized. Nobody is charged until all are.${g.deadline ? ' Deadline ' + esc(when(g.deadline)) + '.' : ''}`;
    case 'capturing': return 'Every cart is authorized. Capturing the group…';
    case 'captured': return `Captured on ${esc(g.vendor.name)}’s account. The shop is portioning and dispatching.`;
    case 'compensating': return 'A capture failed. Refunding and releasing holds…';
    case 'complete': return 'Every portion has been delivered or collected.';
    default: return ({ capture_failed: 'Cancelled: a capture failed, so charges were refunded and holds released.', deadline_passed: 'Cancelled: not every cart was authorized in time. Holds were released.', vendor_disconnected: 'Cancelled: the shop disconnected its payment account.' })[g.cancelReason] || 'Cancelled. Every hold was released.';
  }
}
function timeLeft(d) {
  const ms = Date.parse(d) - Date.now();
  if (ms <= 0) return 'closing now';
  const h = Math.floor(ms / 3600e3);
  return h >= 48 ? `${Math.floor(h / 24)} days left` : h >= 1 ? `${h} h left` : `${Math.max(1, Math.round(ms / 60e3))} min left`;
}
function nearMeta(g) {
  if (g.status !== 'open') return '';
  const bits = [];
  if (g.distanceKm != null) bits.push(chip(g.distanceKm <= 1 ? 'About 1 km away' : `${g.distanceKm} km away`, 'info'));
  if (g.areaLabel) bits.push(chip(g.areaLabel, ''));
  bits.push(chip(g.spotsLeft === 1 ? '1 spot left' : `${g.spotsLeft} spots left`, g.spotsLeft <= 1 ? 'warn' : ''));
  if (g.fillBy) bits.push(chip(`Fills by ${when(g.fillBy)} (${timeLeft(g.fillBy)})`, Date.parse(g.fillBy) - Date.now() < 6 * 3600e3 ? 'warn' : ''));
  return `<div class="near-meta">${bits.join('')}</div>`;
}
function groupCard(g, ctx) {
  const n = g.carts.length, me = g.carts.find(c => c.isMine), auth = g.carts.filter(c => ['authorized', 'captured'].includes(c.status)).length;
  const [label, tone] = GROUP[g.status];
  const acts = [];
  if (ctx !== 'vendor') {
    if (g.status === 'open' && !me && n < g.seats) acts.push(`<button class="btn" data-act="join" data-id="${g.id}">Join, item share ${money(eachOf(g.price, n + 1))}</button>`);
    if (g.status === 'open' && me && !g.isInitiator) acts.push(`<button class="btn ghost small" data-act="leave" data-id="${g.id}">Leave</button>`);
    if (g.status === 'open' && g.isInitiator && n >= 2) acts.push(`<button class="btn small" data-act="close" data-id="${g.id}">Close group with ${n}</button>`);
    if (g.status === 'authorizing' && me && me.status === 'pending') acts.push(`<button class="btn coin" data-act="checkout" data-cart="${me.id}">Check out on ${esc(g.vendor.name)}’s ${esc(g.provider)} page</button>`);
    if (['open', 'authorizing'].includes(g.status) && g.isInitiator) acts.push(`<button class="btn danger small" data-act="cancel" data-id="${g.id}">Cancel group buy</button>`);
  }
  let mine = '';
  if (me && ctx !== 'vendor') {
    const a = me.attempt, d = me.delivery;
    let line = '';
    if (d) line = `${DEL[d.status]}${d.trackingUrl ? ` (<a href="${esc(d.trackingUrl)}" target="_blank" rel="noopener">track</a>)` : ''}.`;
    else if (me.status === 'captured') line = 'Charged. Your portion is being packed.';
    else if (me.status === 'authorized' && a) line = `${esc(a.brand || 'Card')} ${a.last4 ? 'ending ' + esc(a.last4) : ''} authorized. Hold expires ${esc(when(a.authExpiresAt))}.`;
    else if (a?.status === 'declined') line = '<b>Your last attempt was declined.</b> Try another card.';
    else if (a?.status === 'expired' && me.status === 'pending') line = '<b>Your hold expired.</b> Check out again.';
    else if (me.status === 'refunded') line = 'Your charge was refunded.';
    else if (me.status === 'voided') line = 'Your hold was released. You weren’t charged.';
    mine = `<div class="mine"><b>Your cart:</b> ${money(me.itemShare)} item + ${money(me.deliveryFee)} ${DLABEL[me.deliveryMethod]} = <b>${money(me.amount)}</b>${g.status === 'open' ? ' (drops as people join)' : ''}<div class="note">${line}</div></div>`;
  }
  const rows = ctx === 'vendor'
    ? `<div class="carts">${g.carts.map((c, i) => {
        let ctl = chip(...(CART[c.status] || [c.status, '']));
        if (['captured', 'complete'].includes(g.status)) {
          if (!c.delivery) ctl = `<button class="btn coin small" data-act="dispatch" data-cart="${c.id}">${c.deliveryMethod === 'pickup' ? 'Mark ready for pickup' : 'Dispatch with ' + DLABEL[c.deliveryMethod]}</button>`;
          else if (c.delivery.status !== 'delivered' && ['pickup', 'manual'].includes(c.delivery.courier)) ctl = `<button class="btn small" data-act="delivered" data-cart="${c.id}">${c.delivery.courier === 'pickup' ? 'Mark collected' : 'Mark delivered'}</button>`;
          else ctl = chip(DEL[c.delivery.status], c.delivery.status === 'delivered' ? 'good' : 'info');
        }
        const where = c.deliveryMethod === 'pickup' ? 'In-store pickup' : c.address ? `${DLABEL[c.deliveryMethod]} to ${esc(c.address.address)}, ${esc(c.address.phone)}` : DLABEL[c.deliveryMethod];
        const manual = c.delivery?.courier === 'manual' ? ' Courier API not configured: book it yourself.' : '';
        return `<div class="cartrow"><div><b>Cart ${i + 1}</b> for ${esc(c.shopperName)}, ${money(c.amount)}</div>${ctl}<div class="note">${where}.${manual}</div></div>`;
      }).join('')}</div>`
    : `<div class="people">${g.carts.map(c => `<span class="person"><span class="ini">${esc((c.shopperName || '?')[0])}</span>${esc(c.shopperName)}${c.isInitiator ? ' (started it)' : ''} ${g.status !== 'open' ? chip(...(CART[c.status] || [c.status, ''])) : ''}</span>`).join('')}</div>`;
  return `<article class="pool${me ? ' me' : ''}">
    <div class="ringbox">${ring(g.seats, n, auth)}<div class="center"><b>${n}/${g.seats}</b><span>carts</span></div></div>
    <div><h3>${esc(g.itemEmoji || '')} ${esc(g.itemName)}</h3><div class="sub">${esc(g.vendor.name)}. Item ${money(g.price)}</div></div>
    <div class="each">${money(eachOf(g.price, n))} item share<br><small>${g.status === 'open' ? `${money(eachOf(g.price, g.seats))} if all ${g.seats} join, ` : ''}plus each shopper’s delivery</small></div><div></div>
    <div class="full"><div class="status ${g.status}">${chip(label, tone)} ${groupStatus(g)}</div>${nearMeta(g)}${mine}${rows}${acts.length ? `<div class="row">${acts.join('')}</div>` : ''}</div>
  </article>`;
}
function locationBar() {
  const loc = S.loc, geo = S.me?.geocoder;
  return `<div class="locbar">
    <span class="where">${loc ? `Group buys within <select data-act-change="radius" aria-label="Distance">${[2, 5, 10, 25, 50].map(r => `<option value="${r}" ${S.radius === r ? 'selected' : ''}>${r} km</option>`).join('')}</select> of ${esc(loc.label || 'your area')}` : 'Set your area to see group buys near you'}</span>
    <button class="btn small ${loc ? 'ghost' : ''}" data-act="use-location">${loc ? 'Update my location' : 'Share my location'}</button>
    ${geo ? `<form id="loc-search" style="display:flex;gap:6px"><input name="q" placeholder="Postal code or neighborhood" aria-label="Postal code or neighborhood" maxlength="60"><button class="btn ghost small">Set</button></form>` : ''}
    ${loc ? `<label class="toggle" style="background:none;border:0;padding:0"><input type="checkbox" data-act-change="alerts" ${S.me?.location?.alertsEnabled ? 'checked' : ''}> Notify me about new group buys nearby</label>` : ''}
  </div>`;
}
function viewNear() {
  const head = `<div class="section-head"><div><h2>Group buys near you</h2><p>Only shoppers in the same area see these, so groups fill fast. The closest to filling and soonest deadlines come first.</p></div></div>`;
  if (!S.loc) return head + locationBar() + `<div class="empty"><h3>Where are you shopping?</h3><p>Kitty shows group buys started near you, and you can only join groups in your area. Your location is rounded to about 1 km and never shown to other shoppers.</p></div>`;
  if (!S.near) return head + locationBar() + '<p class="note">Loading…</p>';
  return head + locationBar() + (S.near.length ? `<div class="pools">${S.near.map(g => groupCard(g, 'groups')).join('')}</div>`
    : `<div class="empty"><h3>No group buys forming within ${S.radius} km</h3><p>Try a wider distance, or start one from the shop. Neighbors who turned on alerts will hear about it.</p><button class="btn" data-view="shop">Browse the shop</button></div>`);
}
function viewMine() {
  if (!S.mine) return '<p class="note">Loading…</p>';
  const order = { authorizing: 0, open: 1, capturing: 2, compensating: 2, captured: 3, complete: 4, cancelled: 5 };
  const list = S.mine.slice().sort((a, b) => order[a.status] - order[b.status]);
  return `<div class="section-head"><div><h2>My group buys</h2><p>When a group closes, check out on the shop’s payment page. You’re charged only when every cart is authorized.</p></div></div>
    ${list.length ? `<div class="pools">${list.map(g => groupCard(g, 'mine')).join('')}</div>` : `<div class="empty"><h3>You’re not in any group buys yet</h3><p>Start or join one.</p><button class="btn" data-view="groups">See groups forming</button></div>`}`;
}
function viewVendor() {
  if (!S.me) return '<p class="note">Loading…</p>';
  const v = S.me.vendor, c = S.me.connection;
  if (!v) return `<div class="section-head"><div><h2>Sell through group buys</h2><p>List your inventory, connect a payment account, and let shoppers team up to buy.</p></div></div>
    <div class="empty"><h3>Open your shop</h3><p>Add your shop details and delivery options first. Then connect your payment account so shoppers can pay you directly.</p><button class="btn" data-act="shop-form">Open your shop</button></div>`;
  let conn;
  if (!c) conn = `<h3>Connect a payment account</h3><p class="note">Shoppers pay you directly on a checkout page your payment provider hosts. Kitty keeps only your account ID.</p>
      <div class="row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${S.me.providers.map(p => `<button class="btn" data-act="connect" data-provider="${p}">Connect with ${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div>`;
  else if (c.status === 'active') conn = `<h3>${esc(c.provider)} account connected</h3><p class="note"><code>${esc(c.provider_account_id)}</code>. Platform fee ${(c.fee_bps / 100).toFixed(2)}% per captured cart.</p>${chip('Active', 'good')} <button class="btn danger small" data-act="disconnect" style="margin-left:8px">Disconnect</button>`;
  else conn = `<h3>Finish connecting ${esc(c.provider)}</h3><p class="note">${c.status === 'onboarding' ? 'You haven’t finished onboarding.' : c.status === 'restricted' ? 'The provider needs more information before you can take payments.' : 'The provider is verifying your account. This page updates when it’s done.'}</p>
      ${chip(c.status, 'warn')} <button class="btn small" data-act="connect" data-provider="${esc(c.provider)}" style="margin-left:8px">Continue onboarding</button>`;
  const orders = S.orders || [];
  const sum = k => orders.reduce((s, g) => s + ((g.ledger || {})[k] || 0), 0);
  const held = orders.filter(g => ['authorizing', 'capturing'].includes(g.status)).reduce((s, g) => s + g.carts.filter(x => x.status === 'authorized').reduce((a, x) => a + x.amount, 0), 0);
  const gross = sum('captured') - sum('refunded'), fees = orders.filter(g => ['captured', 'complete'].includes(g.status)).reduce((s, g) => s + ((g.ledger || {}).fee || 0), 0);
  const sec = (title, list, empty) => `<div class="section-head"><h3 class="block">${title} (${list.length})</h3></div>${list.length ? `<div class="pools" style="margin-bottom:28px">${list.map(g => groupCard(g, 'vendor')).join('')}</div>` : `<p class="note" style="margin:-8px 0 28px">${empty}</p>`}`;
  return `<div class="vendor-head"><div><h2>${esc(v.name)}</h2><p>${esc(v.area || '')}${v.about ? '. ' + esc(v.about) : ''}</p></div><button class="btn ghost" data-act="shop-form">Edit shop and delivery</button></div>
    <div class="connect-card">${conn}</div>
    <div class="money-row">
      <div class="money-cell"><span>Authorized, on hold</span><b>${money(held)}</b><small>Not charged yet</small></div>
      <div class="money-cell"><span>Captured</span><b>${money(gross)}</b><small>Net of refunds</small></div>
      <div class="money-cell"><span>Platform fees</span><b>${money(fees)}</b><small>Taken at capture</small></div>
      <div class="money-cell"><span>Net to you</span><b>${money(gross - fees)}</b><small>Paid out by your provider</small></div>
    </div>
    ${sec('Ready to dispatch', orders.filter(g => g.status === 'captured'), 'Orders land here once every cart in a group is captured.')}
    <div class="section-head"><h3 class="block">Inventory</h3><button class="btn small" data-act="item-form">Add item</button></div>
    <div class="inv">${S.me.items.length ? `<div class="inv-scroll"><table><thead><tr><th>Item</th><th>Category</th><th class="num">Price</th><th class="num">Stock</th><th></th></tr></thead><tbody>${S.me.items.map(i => `<tr><td>${esc(i.emoji || '')} ${esc(i.name)}</td><td>${esc(i.category || '')}</td><td class="num">${money(i.price)}</td><td class="num">${i.stock}</td><td class="num"><button class="btn ghost small" data-act="item-form" data-item="${i.id}">Edit</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty" style="border:0"><h3>No items listed</h3><p>Add your first item.</p></div>`}</div>
    ${sec('Authorizing', orders.filter(g => ['authorizing', 'capturing', 'compensating'].includes(g.status)), 'None right now.')}
    ${sec('Forming', orders.filter(g => g.status === 'open'), 'None right now.')}
    ${sec('Completed and cancelled', orders.filter(g => ['complete', 'cancelled'].includes(g.status)).slice(0, 10), 'None yet.')}`;
}

// ---------------- setup check ----------------
function setupPanel() {
  const h = S.health;
  return `<div class="panel" style="max-width:720px"><h2>Finish setting up Kitty</h2>
    <p class="note">The site is live, but the backend isn’t ready yet. Fix these in Netlify, then redeploy (Deploys → Trigger deploy → Deploy site) and reload this page.</p>
    <ol class="checks" style="margin:14px 0">${h.problems.map(p => `<li class="bad"><span class="ic">✕</span><span>${esc(p)}</span></li>`).join('')}</ol>
    <p class="note">Status: database ${h.database?.ok ? 'connected' : 'not ready'}, Stripe key ${h.stripe?.keySet ? 'set (' + h.stripe.mode + ' mode)' : 'missing'}, sign-in ${h.signIn?.auth0 ? 'Auth0' : h.signIn?.demo ? 'demo' : 'not configured'}.</p>
    <button class="btn" data-act="recheck">Check again</button></div>`;
}
async function checkHealth() {
  try {
    const r = await fetch('/api/health', { headers: { accept: 'application/json' } });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      S.health = { ok: false, problems: [r.status === 404
        ? 'The /api functions aren’t deployed. Deploy from GitHub (not drag-and-drop), and make sure netlify.toml and package.json are at the top level of the repository.'
        : `The API responded with ${r.status}. Open Netlify → Logs → Functions → api to see the error.`] };
    } else S.health = await r.json();
  } catch (e) { S.health = { ok: false, problems: ['The API couldn’t be reached. Check that the latest deploy is Published.'] }; }
}

// ---------------- checkout return ----------------
function returnPanel() {
  const R = S.ret;
  const step = (cls, text) => `<li class="${cls}"><span class="ic">${cls === 'ok' ? '✓' : cls === 'bad' ? '✕' : ''}</span><span>${text}</span></li>`;
  let items = '';
  if (R.error) items = step('bad', esc(R.error));
  else {
    items += step('ok', 'Return link verified');
    if (R.cancelled) items += step('bad', 'You left checkout without paying. Your cart is still waiting.');
    else {
      const a = R.attempt;
      if (!a || a.status === 'created') items += step('wait', 'Waiting for the payment provider to confirm…');
      else if (a.status === 'declined') items += step('bad', `Payment declined${a.decline_reason ? ': ' + esc(a.decline_reason) : ''}. Try another card.`);
      else if (['authorized', 'captured'].includes(a.status)) {
        items += step('ok', `${esc(a.card_brand || 'Card')} ${a.card_last4 ? 'ending ' + esc(a.card_last4) : ''} authorized`);
        items += a.group_status === 'authorizing' ? step('wait', `${a.authorized} of ${a.carts} carts authorized. Nobody is charged until all are.`)
          : ['captured', 'complete'].includes(a.group_status) ? step('ok', 'Every cart was authorized and the group was captured.')
          : step('wait', 'Capturing the group…');
      } else items += step('bad', 'This payment didn’t go through.');
    }
  }
  return `<div class="panel return-panel"><h2>Back at Kitty</h2><ul class="checks" style="margin:14px 0">${items}</ul><button class="btn" data-act="return-done">Go to my group buys</button></div>`;
}
async function handleReturn(token, cancelled) {
  history.replaceState({}, '', '/#mine');
  S.ret = { cancelled };
  render();
  try { const r = await api('GET', '/checkout/return?token=' + encodeURIComponent(token)); S.ret.attemptId = r.attemptId; }
  catch (e) { S.ret.error = e.message; render(); return; }
  for (let i = 0; i < 40 && S.ret; i++) {
    try { S.ret.attempt = await api('GET', '/attempts/' + S.ret.attemptId); } catch (e) {}
    render();
    const a = S.ret && S.ret.attempt;
    if (cancelled || (a && a.status !== 'created' && !['authorizing', 'capturing'].includes(a.group_status)) || (a && a.status === 'declined')) break;
    if (a && a.status === 'authorized' && a.group_status === 'authorizing') break;
    await sleep(2000);
  }
}

// ---------------- dialogs ----------------
const dlg = $('#dlg');
function openDlg(html, mount) { $('#dlg-body').innerHTML = html; dlg.showModal(); mount && mount($('#dlg-body')); }
const closeDlg = () => dlg.close();
dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) closeDlg(); });

function devSignIn() {
  openDlg(`<form class="dlg" id="dev-form"><h2>Demo sign-in</h2><p class="lede">Test mode: type any name to act as that person, no password. Use a second browser profile to be another shopper. Don’t use this with real payments.</p>
    <label class="f">Your name<input name="who" maxlength="40" required></label><div class="foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Continue</button></div></form>`, root => {
    $('#dev-form', root).addEventListener('submit', e => { e.preventDefault(); const n = e.target.elements.who.value.trim(); if (!n) return;
      localStorage.setItem('kitty-dev-user', n); Auth.user = { name: n }; closeDlg(); renderAuth(); go(S.view); });
  });
}
function deliveryFields(delivery) {
  const opts = ['doordash', 'uber', 'pickup'].filter(k => delivery[k]?.on);
  return `<fieldset class="opts" style="border:0;padding:0;margin:0"><legend style="font-weight:600;font-size:.92rem;margin-bottom:6px">How should your portion reach you?</legend>
    ${opts.map((k, i) => `<label class="opt"><input type="radio" name="method" value="${k}" ${i === 0 ? 'checked' : ''}><span>${DLABEL[k]}</span><span class="meta">${delivery[k].fee ? money(delivery[k].fee) : 'Free'}${delivery[k].eta ? '<br>' + esc(delivery[k].eta) : ''}</span></label>`).join('')}</fieldset>
    <div id="addr-wrap"><label class="f">Delivery address<input name="address" maxlength="200" autocomplete="street-address"></label>
    <label class="f" style="margin-top:10px">Phone for the courier<input name="phone" type="tel" maxlength="20" autocomplete="tel"></label>
    <p class="note" style="margin:6px 0 0">Encrypted, and shared only with the shop and its courier.</p></div>`;
}
function readDelivery(f) {
  const method = (f.querySelector('input[name="method"]:checked') || {}).value;
  return method === 'pickup' ? { method } : { method, address: f.elements.address.value.trim(), phone: f.elements.phone.value.trim() };
}
function wireDelivery(root) {
  const upd = () => { const m = (root.querySelector('input[name="method"]:checked') || {}).value; $('#addr-wrap', root).hidden = m === 'pickup'; };
  root.addEventListener('change', upd); upd();
}
function similarPanel(list) {
  if (!list.length) return '';
  return `<div class="similar"><b>${list.some(g => g.match === 'same_item') ? 'This item already has a group forming near you' : 'Similar group buys are forming near you'}</b>
    <span class="note">Joining one fills it faster and lowers everyone’s share.</span>
    ${list.map(g => `<div class="s-row"><span>${esc(g.itemEmoji || '')} ${esc(g.itemName)} from ${esc(g.vendor.name)}, about ${g.distanceKm} km away. ${g.spotsLeft} of ${g.seats} spots left, item share ${money(eachOf(g.price, g.carts.length + 1))}.</span>
      ${g.carts.some(c => c.isMine) ? chip('You’re in', 'good') : `<button type="button" class="btn small" data-act-local="join-similar" data-id="${g.id}">Join this one</button>`}</div>`).join('')}</div>`;
}
async function needLocation() {
  if (S.loc) return true;
  toast('Share your location first so neighbors can find your group.');
  go('groups');
  return false;
}
async function startDialog(vendorId, itemId) {
  if (!Auth.user) return Auth.login();
  if (!(await needLocation())) return;
  const v = S.catalog.vendors.find(x => x.id === vendorId), it = v.items.find(x => x.id === itemId);
  let seats = 3, confirmNew = false;
  let similar = [];
  try { similar = (await api('GET', `/group-orders/similar?itemId=${itemId}&radius=10`)).similar; } catch (e) {}
  S.similar = similar;
  openDlg(`<form class="dlg" id="start-form" novalidate><h2>Start a group buy</h2><p class="lede">${esc(it.emoji || '')} ${esc(it.name)} from ${esc(v.name)}, ${money(it.price)}</p>
    <div id="similar-slot">${similarPanel(similar)}</div>
    <div><div style="font-weight:600;font-size:.92rem;margin-bottom:6px">How many shoppers, including you?</div>
    <div class="stepper"><button type="button" data-step="-1" aria-label="Fewer">−</button><output id="seats">3</output><button type="button" data-step="1" aria-label="More">+</button><span class="note" id="share"></span></div></div>
    <div class="two"><label class="f">Who can see and join<select name="radius">${[2, 5, 10, 25].map(r => `<option value="${r}" ${r === 10 ? 'selected' : ''}>Shoppers within ${r} km</option>`).join('')}</select></label>
      <label class="f">Fill by<select name="fill">${[[24, 'Within 24 hours'], [72, 'Within 3 days'], [168, 'Within a week']].map(([h, l]) => `<option value="${h}" ${h === 72 ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <label class="f">Area name (optional)<span class="hint">Shown to neighbors, e.g. “Uptown”.</span><input name="area" maxlength="60" value="${esc(S.loc.label || '')}"></label>
    <p class="note" style="margin:0">If it isn’t full by the deadline but at least 2 shoppers joined, it closes with them and the item is split among them. Otherwise it’s cancelled.</p>
    ${deliveryFields(v.delivery)}<p class="err" id="err"></p>
    <div class="foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn" id="start-btn">${similar.length ? 'Start a new group anyway' : 'Start group buy'}</button></div></form>`, root => {
    if (similar.length) confirmNew = true; // they've seen the existing groups
    const upd = () => { $('#seats', root).textContent = seats; $('#share', root).textContent = `Item share ${money(eachOf(it.price, seats))} each if all join.`; };
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-step]'); if (b) { seats = Math.min(10, Math.max(2, seats + +b.dataset.step)); upd(); }
      const j = e.target.closest('[data-act-local="join-similar"]'); if (j) { closeDlg(); joinDialog(j.dataset.id); }
    });
    wireDelivery(root); upd();
    $('#start-form', root).addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target.elements;
      try {
        await api('POST', '/group-orders', { itemId, seats, delivery: readDelivery(e.target), location: S.loc, radiusKm: +f.radius.value, fillByHours: +f.fill.value, areaLabel: f.area.value, confirmNew });
        toast('Group buy started. Neighbors can find it under Near you.'); closeDlg(); go('mine');
      } catch (err) {
        if (err.status === 409 && err.similar) { S.similar = err.similar; $('#similar-slot', root).innerHTML = similarPanel(err.similar); $('#start-btn', root).textContent = 'Start a new group anyway'; confirmNew = true; }
        else if (err.status === 401) Auth.login(); else $('#err', root).textContent = err.message;
      }
    });
  });
}
async function joinDialog(id) {
  if (!(await needLocation())) return;
  const g = (S.near || []).find(x => x.id === id) || (S.similar || []).find(x => x.id === id);
  if (!g) return toast('That group isn’t available in your area.');
  const v = S.catalog?.vendors.find(x => x.id === g.vendor.id);
  if (!v) { toast('This shop isn’t taking orders right now.'); return; }
  openDlg(`<form class="dlg" id="join-form" novalidate><h2>Join this group buy</h2><p class="lede">${esc(g.itemName)} from ${esc(g.vendor.name)}. Item share ${money(eachOf(g.price, g.carts.length + 1))} with you in, plus your delivery.</p>
    ${deliveryFields(v.delivery)}<p class="err"></p><div class="foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Join group</button></div></form>`, root => {
    wireDelivery(root);
    $('#join-form', root).addEventListener('submit', async e => {
      e.preventDefault();
      const r = await act(() => api('POST', `/group-orders/${id}/carts`, { delivery: readDelivery(e.target), location: S.loc }), 'You’re in.');
      if (r) { closeDlg(); go('mine'); }
    });
  });
}
function shopDialog() {
  const v = S.me.vendor || {}, d = v.delivery || { doordash: { on: true, fee: 699, eta: '30 to 45 min' }, uber: { on: false }, pickup: { on: true, eta: 'Ready same day' } };
  const courier = (k, label) => `<fieldset class="courier"><legend><label><input type="checkbox" name="${k}_on" ${d[k]?.on ? 'checked' : ''}> ${label}</label></legend>
    <div class="two"><label class="f">Delivery fee ($)<input name="${k}_fee" type="number" min="0" step="0.01" value="${((d[k]?.fee || 0) / 100).toFixed(2)}"></label><label class="f">Typical time<input name="${k}_eta" maxlength="40" value="${esc(d[k]?.eta || '')}"></label></div></fieldset>`;
  openDlg(`<form class="dlg" id="shop-form" novalidate><h2>${S.me.vendor ? 'Edit your shop' : 'Open your shop'}</h2>
    <label class="f">Shop name<input name="shopName" maxlength="80" value="${esc(v.name || '')}"></label>
    <div class="two"><label class="f">Neighborhood or area<input name="area" maxlength="80" value="${esc(v.area || '')}"></label><label class="f">Pickup phone<input name="pickupPhone" type="tel" maxlength="20" value="${esc(v.pickup_phone || '')}"></label></div>
    <label class="f">Pickup address<span class="hint">Where couriers collect portions.</span><input name="pickupAddress" maxlength="200" value="${esc(v.pickup_address || '')}"></label>
    <label class="f">About<textarea name="about" maxlength="300">${esc(v.about || '')}</textarea></label>
    ${courier('doordash', 'Deliver with DoorDash')}${courier('uber', 'Deliver with Uber')}
    <fieldset class="courier"><legend><label><input type="checkbox" name="pickup_on" ${d.pickup?.on ? 'checked' : ''}> In-store pickup</label></legend><label class="f" style="margin-top:8px">Pickup note<input name="pickup_eta" maxlength="40" value="${esc(d.pickup?.eta || '')}"></label></fieldset>
    <div class="foot"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save shop</button></div></form>`, root => {
    $('#shop-form', root).addEventListener('submit', async e => {
      e.preventDefault(); const f = e.target.elements, c = x => Math.round(parseFloat(x || '0') * 100) || 0;
      const r = await act(() => api('PUT', '/vendor', { name: f.shopName.value, area: f.area.value, about: f.about.value, pickupAddress: f.pickupAddress.value, pickupPhone: f.pickupPhone.value,
        delivery: { doordash: { on: f.doordash_on.checked, fee: c(f.doordash_fee.value), eta: f.doordash_eta.value }, uber: { on: f.uber_on.checked, fee: c(f.uber_fee.value), eta: f.uber_eta.value }, pickup: { on: f.pickup_on.checked, eta: f.pickup_eta.value } } }), 'Shop saved.');
      if (r) { closeDlg(); go('vendor'); }
    });
  });
}
function itemDialog(id) {
  const it = S.me.items.find(x => x.id === id) || {};
  openDlg(`<form class="dlg" id="item-form" novalidate><h2>${id ? 'Edit item' : 'Add an item'}</h2>
    <div class="two" style="grid-template-columns:80px 1fr"><label class="f">Icon<input name="emoji" maxlength="4" value="${esc(it.emoji || '📦')}"></label><label class="f">Item name<input name="itemName" maxlength="100" value="${esc(it.name || '')}"></label></div>
    <div class="two"><label class="f">Price ($)<input name="price" type="number" min="0.01" step="0.01" value="${it.price ? (it.price / 100).toFixed(2) : ''}"></label><label class="f">In stock<input name="stock" type="number" min="0" step="1" value="${it.stock ?? 1}"></label></div>
    <label class="f">Category<select name="category">${CATS.map(c => `<option ${it.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <label class="f">Description<textarea name="description" maxlength="400">${esc(it.description || '')}</textarea></label>
    <div class="foot">${id ? '<button type="button" class="btn danger" data-act-local="remove" style="margin-right:auto">Remove</button>' : ''}<button type="button" class="btn ghost" data-close>Cancel</button><button class="btn">Save item</button></div></form>`, root => {
    const f = $('#item-form', root);
    root.addEventListener('click', async e => { if (e.target.closest('[data-act-local="remove"]')) { if (await act(() => api('DELETE', '/vendor/items/' + id), 'Item removed.')) { closeDlg(); go('vendor'); } } });
    f.addEventListener('submit', async e => {
      e.preventDefault(); const x = f.elements;
      const payload = { name: x.itemName.value, emoji: x.emoji.value, price: Math.round(parseFloat(x.price.value) * 100), stock: parseInt(x.stock.value, 10), category: x.category.value, description: x.description.value };
      if (await act(() => api(id ? 'PUT' : 'POST', '/vendor/items' + (id ? '/' + id : ''), payload), 'Item saved.')) { closeDlg(); go('vendor'); }
    });
  });
}

function inboxDialog() {
  const items = S.inbox?.items || [];
  openDlg(`<div class="dlg"><h2>Notifications</h2>${items.length ? `<ul class="notes">${items.map(n => `<li class="${n.read ? '' : 'unread'}" data-note="${n.id}" data-kind="${n.kind}"><b>${esc(n.title)}</b><div>${esc(n.body)}</div><time>${esc(when(n.createdAt))}</time></li>`).join('')}</ul>` : '<p class="note">Nothing yet. Turn on nearby alerts under Near you to hear about new group buys.</p>'}
    <div class="foot"><button class="btn ghost" data-close>Close</button></div></div>`, root => {
    root.addEventListener('click', e => {
      const li = e.target.closest('[data-note]'); if (!li) return;
      closeDlg(); go(li.dataset.kind === 'nearby_group' ? 'groups' : 'mine');
    });
  });
  if (S.inbox?.unread) api('POST', '/notifications/read', {}).then(() => { S.inbox.unread = 0; render(); }).catch(() => {});
}
async function shareLocation() {
  if (!navigator.geolocation) return toast('This browser can’t share location. Enter a postal code instead.');
  navigator.geolocation.getCurrentPosition(async pos => {
    const r = await act(() => api('PUT', '/me/location', { lat: pos.coords.latitude, lng: pos.coords.longitude, label: S.loc?.label || '' }), 'Location updated.');
    if (r) { S.loc = r; S.me && (S.me.location = r); go(S.view === 'shop' ? 'shop' : 'groups'); }
  }, () => toast('Location permission was denied. Enter a postal code instead, or allow location for this site.'), { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
}
document.addEventListener('change', async e => {
  const k = e.target.dataset?.actChange;
  if (k === 'radius') { S.radius = +e.target.value; localStorage.setItem('kitty-radius', S.radius); S.near = null; go('groups'); }
  if (k === 'alerts') { const r = await act(() => api('PUT', '/me/location', { alertsEnabled: e.target.checked, alertRadiusKm: S.radius }), e.target.checked ? 'You’ll be notified about new group buys nearby.' : 'Nearby alerts off.'); if (r && S.me) S.me.location = r; }
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'loc-search') return;
  e.preventDefault();
  const r = await act(() => api('PUT', '/me/location', { query: e.target.elements.q.value }), 'Area set.');
  if (r) { S.loc = r; S.me && (S.me.location = r); go('groups'); }
});

// ---------------- events ----------------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-view]');
  if (!t || dlg.contains(t)) return;
  if (t.dataset.view && !t.dataset.act) return go(t.dataset.view);
  const id = t.dataset.id, cart = t.dataset.cart;
  const busy = async fn => { t.disabled = true; try { await fn(); } finally { t.disabled = false; } };
  switch (t.dataset.act) {
    case 'recheck': await checkHealth(); render(); if (S.health.ok) go(S.view); return;
    case 'login': return Auth.login();
    case 'inbox': return inboxDialog();
    case 'use-location': return shareLocation();
    case 'logout': return Auth.logout();
    case 'start': return startDialog(t.dataset.vendor, t.dataset.item);
    case 'join': if (!S.catalog) S.catalog = await api('GET', '/catalog'); return joinDialog(id);
    case 'leave': return busy(async () => { if (await act(() => api('DELETE', `/group-orders/${id}/carts/mine`), 'You left the group.')) go(S.view); });
    case 'close': return busy(async () => { if (await act(() => api('POST', `/group-orders/${id}/close`), 'Group closed. Everyone can check out now.')) go(S.view); });
    case 'cancel': if (!confirm('Cancel this group buy? Every hold is released and nobody is charged.')) return;
      return busy(async () => { if (await act(() => api('POST', `/group-orders/${id}/cancel`), 'Group buy cancelled.')) go(S.view); });
    case 'checkout': return busy(async () => { const r = await act(() => api('POST', `/carts/${cart}/checkout`)); if (r && r.url) location.href = r.url; });
    case 'return-done': S.ret = null; return go('mine');
    case 'shop-form': return shopDialog();
    case 'item-form': return itemDialog(t.dataset.item);
    case 'connect': return busy(async () => { const r = await act(() => api('POST', `/connect/${t.dataset.provider}/start`)); if (r && r.url) location.href = r.url; });
    case 'disconnect': if (!confirm('Disconnect your payment account? Open and authorizing groups are cancelled and their holds released.')) return;
      return busy(async () => { if (await act(() => api('POST', '/connect/disconnect'), 'Payment account disconnected.')) go('vendor'); });
    case 'dispatch': return busy(async () => { if (await act(() => api('POST', `/carts/${cart}/dispatch`), 'Dispatched.')) go('vendor'); });
    case 'delivered': return busy(async () => { if (await act(() => api('POST', `/carts/${cart}/delivered`), 'Marked delivered.')) go('vendor'); });
  }
});
document.addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; const pos = e.target.selectionStart; render(); const q = $('#q'); q.focus(); q.setSelectionRange(pos, pos); } });

// Light polling while visible, so other shoppers' actions show up.
setInterval(async () => { if (document.hidden || S.ret || dlg.open || !Auth.user || S.view === 'shop') return; await load(); render(); }, 8000);

(async function boot() {
  await checkHealth();
  if (S.health && !S.health.ok) { render(); return; }
  try { await Auth.init(); }
  catch (e) { S.health = { ...S.health, ok: false, problems: ['public/config.js is set to Auth0, but the Auth0 script didn’t load or the domain/client ID is wrong. For testing, set mode to \'demo\' and DEMO_AUTH=true.'] }; render(); return; }
  if (Auth.mode === 'demo' && S.health.signIn && !S.health.signIn.demo) { S.health = { ...S.health, ok: false, problems: ['public/config.js uses demo sign-in, but the server doesn’t allow it. Add the environment variable DEMO_AUTH=true (test keys only) and redeploy, or switch config.js to Auth0.'] }; render(); return; } // may replace the URL after an Auth0 redirect, so read the query string afterwards
  const qs = new URLSearchParams(location.search);
  renderAuth();
  if (qs.has('connected')) toast(qs.get('connected') === 'active' ? 'Payment account connected.' : 'Account submitted. The provider is verifying it.');
  if (qs.has('connect_error')) toast(qs.get('connect_error'));
  const ret = qs.get('checkout_return');
  if (ret) {
    if (!Auth.user) { S.view = 'mine'; render(); return Auth.login(); }
    return handleReturn(ret, qs.get('cancelled') === '1');
  }
  if (qs.has('connected') || qs.has('connect_error')) history.replaceState({}, '', '/#vendor');
  const v = (location.hash || '#shop').slice(1);
  go(['shop', 'groups', 'mine', 'vendor'].includes(v) ? v : 'shop');
})();
