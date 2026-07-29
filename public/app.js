export const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
export const qtyFmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

// The browser authenticates with the session cookie; a 401 sends you to sign
// in. (API clients use the bearer token instead — see README.)
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  })
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = '/login.html'
    throw new Error('signed out')
  }
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

export function el(html) {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content
}

// Pages grouped for the two-tier nav: group row on top, that group's pages
// below. Dashboard stands alone.
const GROUPS = [
  ['dashboard', 'Dashboard', [['dashboard', '/', 'Dashboard']]],
  ['operations', 'Operations', [
    ['planning', '/planning.html', 'Planning'],
    ['purchasing', '/purchasing.html', 'Purchasing'],
    ['sales', '/sales.html', 'Sales'],
    ['channels', '/channels.html', 'Channels'],
    ['production', '/production.html', 'Production'],
    ['trace', '/trace.html', 'Trace'],
    ['capacity', '/capacity.html', 'Capacity'],
    ['people', '/people.html', 'People'],
  ]],
  ['money', 'Money', [
    ['finance', '/finance.html', 'Finance'],
    ['bank', '/bank.html', 'Bank'],
    ['financials', '/financials.html', 'Financials'],
    ['reports', '/reports.html', 'Reports'],
    ['qb', '/qb.html', 'QuickBooks'],
  ]],
  ['setup', 'Setup', [['import', '/import.html', 'Import']]],
]

export function mountNav(active) {
  const nav = document.getElementById('nav')
  if (!nav) return
  const activeGroup =
    GROUPS.find(([, , pages]) => pages.some(([key]) => key === active)) ?? GROUPS[0]
  const groupRow = GROUPS.map(
    ([gkey, glabel, pages]) =>
      `<a href="${pages[0][1]}" class="${gkey === activeGroup[0] ? 'active' : ''}">${glabel}</a>`,
  ).join('')
  const pageRow =
    activeGroup[2].length > 1
      ? `<nav class="tabs subtabs">${activeGroup[2]
          .map(([key, href, label]) => `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`)
          .join('')}</nav>`
      : ''
  nav.outerHTML = `<div id="navwrap"><nav class="tabs">${groupRow}</nav>${pageRow}</div>`
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
       <h1>Countinghouse</h1><span class="badge">PHASE 1</span>
       <span class="tenant" id="whoami"></span>
     </header>
     <div id="nav"></div>
     <p class="sub">${subtitle}</p>`,
  )
  document.title = `Countinghouse — ${title}`
  mountNav(active)
  fetch('/auth/me')
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((me) => {
      document.getElementById('whoami').innerHTML =
        `${me.tenant} · ${me.user.name} <a href="#" id="logout" style="color:var(--ink-3); font-size:12px">sign out</a>`
      document.getElementById('logout').addEventListener('click', async (e) => {
        e.preventDefault()
        await fetch('/auth/logout', { method: 'POST' })
        location.href = '/login.html'
      })
    })
    .catch(() => {
      if (!location.pathname.startsWith('/login')) location.href = '/login.html'
    })
}
