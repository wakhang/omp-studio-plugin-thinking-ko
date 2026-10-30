// Shows Korean summaries of the agent's thinking at the top of every "작업 과정" fold (visible even while
// the fold is collapsed) and hides noisy tool cards (bash etc.). Thinking text is read from the React
// props of the fold, because collapsed folds do not render their blocks into the DOM.

const DEFAULT_HIDDEN = ['bash', 'eval', 'read', 'grep', 'glob', 'find', 'ls', 'todo', 'wait']
const SETTLE_MS = 2500
const SHOW_LAST = 4 // lines shown per fold until "더 보기" // a still-streaming thinking block is summarized once its text stops growing

let observer = null
let settingsSub = null
let scheduled = false
let scheduleRef = () => {}

export function activate(ctx) {
  let since = 0
  ctx.storage.get('since').then((v) => {
    since = typeof v === 'number' ? v : Date.now()
    if (typeof v !== 'number') ctx.storage.set('since', since)
    schedule()
  })
  const summaries = new Map() // text -> summary | Promise | Error
  let settings = ctx.settings.get() || {}
  const hidden = () => new Set((Array.isArray(settings.hiddenTools) ? settings.hiddenTools : DEFAULT_HIDDEN).map((s) => String(s).trim().toLowerCase()).filter(Boolean))

  const applyRootClasses = () => {
    document.documentElement.classList.toggle('kt-hide-original', settings.showOriginal !== true)
    document.documentElement.classList.toggle('kt-off', settings.enabled === false)
  }

  // ---------- React props access ----------
  const fiberOf = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'))
    return k ? el[k] : null
  }
  // The fold's data: TurnGroup props ({ row: { turn: [...] } }) in current builds, or older per-message
  // fold props whose children hold the blocks. Walk up the fiber tree from the fold element.
  const foldProps = (el) => {
    let f = fiberOf(el)
    for (let i = 0; f && i < 16; i++, f = f.return) {
      const p = f.memoizedProps
      if (p && typeof p === 'object' && p.row && Array.isArray(p.row.turn)) return p
    }
    f = fiberOf(el)
    for (let i = 0; f && i < 16; i++, f = f.return) {
      const p = f.memoizedProps
      if (p && typeof p === 'object' && 'stats' in p && 'children' in p && typeof p.children !== 'function') return p
    }
    return null
  }
  // Ordered thinking blocks of the fold.
  const collectThinking = (props) => {
    const out = []
    if (props.row && Array.isArray(props.row.turn)) {
      for (const it of props.row.turn) {
        if (!it || it.kind !== 'assistant' || !Array.isArray(it.blocks)) continue
        for (const bl of it.blocks) if (bl && bl.type === 'thinking' && typeof bl.text === 'string' && bl.text.trim()) out.push({ text: bl.text, streaming: !!it.streaming, at: typeof it.timestamp === 'number' ? it.timestamp : Date.now() })
      }
      return out
    }
    const seen = new WeakSet()
    const walk = (x, depth, streaming) => {
      if (!x || typeof x !== 'object' || depth > 9 || seen.has(x)) return
      if (x.nodeType || x instanceof Window) return
      seen.add(x)
      if (Array.isArray(x)) {
        for (const y of x) walk(y, depth + 1, streaming)
        return
      }
      if (x.type === 'thinking' && typeof x.text === 'string') {
        if (x.text.trim()) out.push({ text: x.text, streaming: !!streaming })
        return
      }
      const p = x.props
      if (p && typeof p === 'object') {
        walk(p, depth + 1, streaming || p.streaming === true)
        return
      }
      for (const k of Object.keys(x)) {
        if (k === '_owner' || k === '_store' || k.startsWith('__')) continue
        const v = x[k]
        if (v && typeof v === 'object') walk(v, depth + 1, streaming || x.streaming === true)
      }
    }
    walk(props.children, 0, false)
    return out
  }

  // ---------- summaries ----------
  const lastSeen = new Map() // text prefix key -> { text, at }
  const request = (text) => {
    if (summaries.has(text)) return
    const p = ctx.channel
      .invoke('kt.summarize', { text })
      .then((s) => summaries.set(text, s || '(요약 없음)'))
      .catch((e) => summaries.set(text, e instanceof Error ? e : new Error(String(e))))
      .finally(schedule)
    summaries.set(text, p)
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  const renderDigest = (fold, blocks) => {
    let digest = fold.querySelector(':scope > .kt-digest')
    if (!blocks.length) {
      if (digest) digest.remove()
      return
    }
    const sig = (digest && digest.classList.contains('kt-all') ? blocks : blocks.slice(-SHOW_LAST)).map((b) => {
      const s = summaries.get(b.text)
      return `${b.text.length}:${typeof s === 'string' ? s.length : s instanceof Error ? 'e' : s ? 'p' : 'n'}`
    }).join('|')
    if (digest && digest.dataset.sig === sig) return
    if (!digest) {
      digest = el('div', 'kt-digest')
      const head = fold.querySelector(':scope > .process-head')
      if (head) head.after(digest)
      else fold.prepend(digest)
    }
    const all = digest.classList.contains('kt-all')
    const shown = all ? blocks : blocks.slice(-SHOW_LAST)
    const offset = blocks.length - shown.length
    digest.dataset.sig = sig + (all ? '|all' : '')
    const openSet = new Set([...digest.querySelectorAll('.kt-item.open')].map((n) => n.dataset.i))
    const more = []
    if (offset > 0 || all) {
      const m = el('button', 'kt-more', all ? '최근 것만 보기' : `이전 생각 ${offset}개 더 보기`)
      m.type = 'button'
      m.addEventListener('click', (e) => {
        e.stopPropagation()
        digest.classList.toggle('kt-all')
        digest.dataset.sig = ''
        schedule()
      })
      if (blocks.length > SHOW_LAST) more.push(m)
    }
    digest.replaceChildren(
      ...more,
      ...shown.map((b, j) => {
        const i = j + offset
        const s = summaries.get(b.text)
        const item = el('div', 'kt-item' + (openSet.has(String(i)) ? ' open' : ''))
        item.dataset.i = String(i)
        const line = el('div', 'kt-line')
        const icon = el('span', 'kt-icon', '💭')
        let txt
        if (typeof s === 'string') txt = el('span', 'kt-text', s)
        else if (s instanceof Error) txt = el('span', 'kt-text kt-err', `요약 실패 — ${s.message.slice(0, 120)}`)
        else txt = el('span', 'kt-text kt-pending', b.streaming ? '생각 중…' : '한글로 요약하는 중…')
        const btn = el('button', 'kt-orig-btn', '원문')
        btn.type = 'button'
        btn.title = '영어 원문 보기/접기'
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          item.classList.toggle('open')
        })
        line.append(icon, txt, btn)
        item.append(line, el('div', 'kt-orig', b.text))
        return item
      })
    )
  }

  // ---------- tool cards ----------
  const markTools = (root) => {
    const hide = hidden()
    for (const card of root.querySelectorAll('.tool-card')) {
      const name = (card.querySelector(':scope > .tool-head .tool-name')?.textContent || '').trim().toLowerCase()
      if (card.dataset.ktTool !== name) card.dataset.ktTool = name
      card.classList.toggle('kt-hidden', settings.enabled !== false && hide.has(name))
    }
  }

  // ---------- scan ----------
  const scan = () => {
    scheduled = false
    if (settings.enabled === false) {
      for (const d of document.querySelectorAll('.kt-digest')) d.remove()
      markTools(document)
      return
    }
    const now = Date.now()
    const vh = window.innerHeight
    for (const fold of document.querySelectorAll('.process-fold')) {
      const props = foldProps(fold)
      if (!props) continue
      const blocks = since ? collectThinking(props).filter((b) => b.at >= since) : []
      fold.classList.toggle('kt-active', blocks.length > 0)
      const rect = fold.getBoundingClientRect()
      const near = rect.bottom > -600 && rect.top < vh + 600 && rect.height > 0
      const wanted = fold.querySelector(':scope > .kt-digest.kt-all') ? blocks : blocks.slice(-SHOW_LAST)
      for (const b of near ? wanted : []) {
        if (summaries.has(b.text)) continue
        const key = b.text.slice(0, 200)
        const prev = lastSeen.get(key)
        if (!b.streaming || (prev && prev.text === b.text && now - prev.at >= SETTLE_MS)) request(b.text)
        else if (!prev || prev.text !== b.text) {
          lastSeen.set(key, { text: b.text, at: now })
          setTimeout(schedule, SETTLE_MS + 100)
        }
      }
      renderDigest(fold, blocks)
    }
    markTools(document)
  }
  const schedule = () => {
    scheduleRef = schedule
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(scan)
  }

  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      // ignore our own digest updates
      const t = m.target
      if (t && t.nodeType === 1 && (t.closest('.kt-digest') || (t.classList && t.classList.contains('kt-digest')))) continue
      schedule()
      return
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  document.addEventListener('scroll', schedule, true)
  settingsSub = ctx.settings.onChange((next) => {
    settings = next || {}
    applyRootClasses()
    for (const d of document.querySelectorAll('.kt-digest')) d.dataset.sig = ''
    schedule()
  })
  applyRootClasses()
  schedule()
}

export function deactivate() {
  if (observer) observer.disconnect()
  document.removeEventListener('scroll', scheduleRef, true)
  if (settingsSub) settingsSub.dispose()
  observer = null
  settingsSub = null
  for (const d of document.querySelectorAll('.kt-digest')) d.remove()
  for (const c of document.querySelectorAll('.tool-card.kt-hidden')) c.classList.remove('kt-hidden')
  for (const f of document.querySelectorAll('.process-fold.kt-active')) f.classList.remove('kt-active')
  document.documentElement.classList.remove('kt-hide-original', 'kt-off')
}
