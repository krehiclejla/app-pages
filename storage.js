let chatTitleCache = new Map()
let chatTitlesPromise = null
let chatTitlePermission = 'unknown'

async function responseDetail(response) {
  try {
    const body = await response.json()
    return body?.detail || body?.error || ''
  } catch {
    return ''
  }
}

async function responseError(response, fallback) {
  const detail = await responseDetail(response)
  const error = new Error(detail || fallback)
  error.status = response.status
  return error
}

export function makeStorage(appId, token) {
  const runtime = (typeof window !== 'undefined' && window.mobius?.storage) || null
  const auth = { Authorization: `Bearer ${token}` }

  function artifactDataPath(artifactId, key) {
    return `artifact-data/${artifactId}/${key}.json`
  }

  async function get(path) {
    if (runtime?.get) return runtime.get(path)
    const response = await fetch(`/api/storage/apps/${appId}/${path}`, { headers: auth })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Could not read ${path} (${response.status}).`)
    return response.json()
  }

  async function getFresh(path) {
    const response = await fetch(`/api/storage/apps/${appId}/${path}`, { headers: auth })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Could not read ${path} (${response.status}).`)
    return response.json()
  }

  async function getText(path) {
    if (runtime?.getText) return runtime.getText(path)
    const response = await fetch(`/api/storage/apps/${appId}/${path}`, { headers: auth })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`Could not read ${path} (${response.status}).`)
    return response.text()
  }

  async function setJSON(path, value) {
    if (runtime?.set) return runtime.set(path, value)
    const response = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
    if (!response.ok) throw await responseError(response, `Could not save ${path} (${response.status}).`)
    return { synced: true }
  }

  async function setText(path, value) {
    if (runtime?.setText) return runtime.setText(path, value)
    const response = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'text/html;charset=utf-8' },
      body: value,
    })
    if (!response.ok) throw await responseError(response, `Could not save ${path} (${response.status}).`)
    return { synced: true }
  }

  async function setBlob(path, value) {
    if (runtime?.setBlob) return runtime.setBlob(path, value)
    const response = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': value?.type || 'application/octet-stream' },
      body: value,
    })
    if (!response.ok) throw await responseError(response, `Could not save ${path} (${response.status}).`)
    return { synced: true }
  }

  async function remove(path) {
    if (runtime?.remove) return runtime.remove(path)
    const response = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'DELETE', headers: auth,
    })
    if (!response.ok && response.status !== 404) {
      throw new Error(`Could not remove ${path} (${response.status}).`)
    }
    return { synced: true }
  }

  async function list(prefix = '', options = {}) {
    if (runtime?.list) return runtime.list(prefix, options)
    const entries = []
    let cursor = null
    do {
      const params = new URLSearchParams({ limit: '500' })
      if (cursor) params.set('cursor', cursor)
      if (options.includeContent) params.set('include_content', 'true')
      const response = await fetch(`/api/storage/apps-list/${appId}/${prefix}?${params}`, { headers: auth })
      if (!response.ok) throw new Error(`Could not list ${prefix} (${response.status}).`)
      const page = await response.json()
      entries.push(...(Array.isArray(page.entries) ? page.entries : []))
      cursor = page.next_cursor || null
    } while (cursor)
    return entries
  }

  function subscribe(path, callback) {
    if (runtime?.subscribe) return runtime.subscribe(path, callback)
    let active = true
    get(path).then((value) => { if (active) callback(value) }).catch(() => {})
    return () => { active = false }
  }

  async function removeFolder(path) {
    const response = await fetch(`/api/storage/apps/${appId}/folder/${path}`, {
      method: 'DELETE', headers: auth,
    })
    if (!response.ok && response.status !== 404) {
      const detail = await responseDetail(response)
      throw new Error(detail || `Could not remove ${path} (${response.status}).`)
    }
    return { synced: true }
  }

  async function publish(projectId, linkPreview = null) {
    const response = await fetch(`/api/apps/${appId}/publish`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        ...(linkPreview ? { link_preview: linkPreview } : {}),
      }),
    })
    if (!response.ok) {
      throw await responseError(response, `Could not publish (${response.status}).`)
    }
    return response.json()
  }

  async function unpublish(projectId) {
    const response = await fetch(`/api/apps/${appId}/publish?project_id=${encodeURIComponent(projectId)}`, {
      method: 'DELETE', headers: auth,
    })
    if (!response.ok && response.status !== 404) {
      const detail = await responseDetail(response)
      throw new Error(detail || `Could not stop sharing (${response.status}).`)
    }
  }

  async function artifactDataGet(artifactId, key) {
    return get(artifactDataPath(artifactId, key))
  }

  async function artifactDataKeys(artifactId) {
    // Ordinary app storage already derives listings from the directory, so no
    // client-maintained index or Pages-specific API is needed.
    const entries = await list(`artifact-data/${artifactId}`)
    return entries
      .filter((entry) => entry?.type === 'file' && /^[a-z0-9._-]{1,64}\.json$/.test(entry.name || ''))
      .map((entry) => entry.name.slice(0, -5))
      .sort()
  }

  async function artifactDataSet(artifactId, key, value) {
    await setJSON(artifactDataPath(artifactId, key), value)
  }

  async function artifactDataRemove(artifactId, key) {
    await remove(artifactDataPath(artifactId, key))
  }

  return {
    get,
    getFresh,
    getText,
    setJSON,
    setText,
    setBlob,
    remove,
    list,
    subscribe,
    removeFolder,
    publish,
    unpublish,
    artifactDataGet,
    artifactDataKeys,
    artifactDataSet,
    artifactDataRemove,
  }
}

export async function loadChatTitles(token) {
  if (chatTitlePermission === 'forbidden') {
    return { permission: 'forbidden', titles: chatTitleCache }
  }
  if (chatTitlesPromise) return chatTitlesPromise
  chatTitlesPromise = (async () => {
    let cursor = 0
    const nextTitles = new Map()
    do {
      const params = new URLSearchParams({ limit: '100', cursor: String(cursor) })
      const response = await fetch(`/api/chat-logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (response.status === 403) {
        chatTitlePermission = 'forbidden'
        return { permission: 'forbidden', titles: chatTitleCache }
      }
      if (!response.ok) throw new Error(`Could not load chat titles (${response.status}).`)
      const page = await response.json()
      for (const item of Array.isArray(page.items) ? page.items : []) {
        if (item?.id) nextTitles.set(String(item.id), String(item.title || 'Untitled chat'))
      }
      cursor = page.next_cursor
    } while (cursor !== null && cursor !== undefined)
    chatTitleCache = nextTitles
    chatTitlePermission = 'allowed'
    return { permission: 'allowed', titles: chatTitleCache }
  })().finally(() => { chatTitlesPromise = null })
  return chatTitlesPromise
}
