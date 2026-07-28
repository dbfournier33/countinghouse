export const TOKEN = 'dev-bigsur'

export const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
export const qtyFmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

export function el(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content
}

const PAGES = [
  ['dashboard', '/', 'Dashboard'],
  ['import', '/import.html', 'Import'],
  ['planning', '/planning.html', 'Planning'],
  ['purchasing', '/purchasing.html', 'Purchasing'],
  ['sales', '/sales.html', 'Sales'],
  ['channels', '/channels.html', 'Channels'],
  ['production', '/production.html', 'Production'],
  ['capacity', '/capacity.html', 'Capacity'],
  ['people', '/people.html', 'People'],
  ['finance', '/finance.html', 'Finance'],
  ['financials', '/financials.html', 'Financials'],
  ['qb', '/qb.html', 'QuickBooks'],
]

export function mountNav(active) {
  const nav = document.getElementById('nav')
  if (!nav) return
  nav.outerHTML = `<nav class="tabs">${PAGES.map(
    ([key, href, label]) => `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`,
  ).join('')}</nav>`
}

let toastTimer
export function toast(message, isError = false) {
  let t = document.getElementById('toast')
  if (!t) {
    t = document.createElement('div')
    t.id = 'toast'
    document.body.appendChild(t)
  }
  t.textContent = message
  t.className = 'show' + (isError ? ' err' : '')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.className = ''), 3200)
}

export function statusBadge(s) {
  return `<span class="status ${s}">${s.replace(/_/g, ' ')}</span>`
}

export function pageShell({ active, title, subtitle }) {
  document.querySelector('.wrap').insertAdjacentHTML(
    'afterbegin',
    `<header>
       <h1>Simple ERP</h1><span class="badge">PHASE 1</span>
       <span class="tenant">Big Sur Provisions</span>
     </header>
     <div id="nav"></div>
     <p class="sub">${subtitle}</p>`,
  )
  document.title = `Simple ERP — ${title}`
  mountNav(active)
}
