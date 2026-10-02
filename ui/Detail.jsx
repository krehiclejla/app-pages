import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  artifactFilename,
  injectArtifactStorageShim,
  shareNeedsUpdate,
  publishedShare,
  stoppedShare,
  versionPath,
} from '../domain.js'
import { loadChatTitles } from '../storage.js'
import {
  ARTIFACT_PREVIEW_FILENAME,
  artifactLinkPreviewMetadata,
  injectLegacyArtifactLinkPreview,
  renderArtifactLinkPreviewPng,
} from '../linkPreview.js'
import { ArtifactFrame } from '../preview/ArtifactFrame.jsx'
import { SourceViewer } from './SourceViewer.jsx'
import { VersionSheet } from './VersionTimeline.jsx'
import { ArtifactOptionsSheet, DeleteSheet, ShareSheet } from './ShareSheet.jsx'
import { copyPlainText } from './clipboard.js'
import { createDetailSync } from './detailSync.js'
import { removePageStorage } from './deletePage.js'
import {
  ArrowLeftIcon,
  CodeIcon,
  EyeIcon,
  MoreIcon,
  ReloadIcon,
} from './Icons.jsx'

function postToShell(message) {
  window.parent.postMessage(message, '*')
}

function toPublicUrl(value) {
  try { return new URL(value, window.location.origin).href } catch { return String(value || '') }
}

const TOO_LARGE_MESSAGE = 'This page is too large to share — ask the agent to trim it.'

function isPayloadTooLarge(error) {
  return Number(error?.status || error?.response?.status) === 413
    || /\b413\b/.test(String(error?.message || ''))
}

function shareFailureMessage(error, fallback) {
  if (error?.userMessage) return error.userMessage
  if (isPayloadTooLarge(error)) return TOO_LARGE_MESSAGE
  return error?.message || fallback
}

export function Detail({ artifactId, storage, token, onPreviewFrame, onClose, onDeleted }) {
  const [record, setRecord] = useState(null)
  const [share, setShare] = useState(null)
  const [shareKnown, setShareKnown] = useState(false)
  const [status, setStatus] = useState('loading')
  const [selectedVersion, setSelectedVersion] = useState(null)
  const [sourceReloadTick, setSourceReloadTick] = useState(0)
  const [viewMode, setViewMode] = useState('preview')
  const [sourceState, setSourceState] = useState({ key: '', status: 'idle', html: '', message: '' })
  const [shareOpen, setShareOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState(null)
  const [chatInfo, setChatInfo] = useState({ permission: 'loading', title: null })
  const detailSyncRef = useRef(null)

  const showToast = useCallback((message, tone = '') => {
    setToast({ message, tone, key: Date.now() })
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    setStatus('loading')
    setShare(null)
    setShareKnown(false)
    setSelectedVersion(null)
    setViewMode('preview')
    setSourceState({ key: '', status: 'idle', html: '', message: '' })
    const acceptRecord = (value) => {
      setRecord((current) => {
        if (!value) return null
        if (!current || current.id !== value.id) return value
        const currentTime = new Date(current.updated_at || current.created_at || 0).getTime()
        const nextTime = new Date(value.updated_at || value.created_at || 0).getTime()
        const currentVersion = Number(current.current_version) || 0
        const nextVersion = Number(value.current_version) || 0
        return nextVersion > currentVersion || nextTime >= currentTime ? value : current
      })
      setStatus(value ? 'ready' : 'missing')
    }
    const acceptShare = (value) => {
      if (value) {
        setShare(value)
        setShareKnown(true)
        return
      }
      // Keep a recovered share visible: bounded absence rechecks still return
      // null, and clearing would make Stop sharing disappear from a page that
      // is genuinely still live.
      setShare((current) => (current?.recovered ? current : null))
      setShareKnown(true)
    }
    const sync = createDetailSync({
      artifactId,
      storage,
      onRecord: acceptRecord,
      onRecordError: (error) => {
        setStatus('error')
        showToast(error?.message || 'Page could not be loaded.', 'error')
      },
      onShare: acceptShare,
      onRecoveredShare: (recovered) => {
        setShare((current) => (current?.published ? current : recovered))
      },
    })
    detailSyncRef.current = sync
    sync.start()
    const refresh = (options) => {
      if (document.visibilityState !== 'hidden') void sync.refresh(options)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh({ forceShare: true })
    }
    const onFocus = () => refresh({ forceShare: true })
    const timer = window.setInterval(refresh, 3500)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      if (detailSyncRef.current === sync) detailSyncRef.current = null
      sync.dispose()
    }
  }, [artifactId, showToast, storage])

  useEffect(() => {
    if (!record?.chat_id) {
      setChatInfo({ permission: 'allowed', title: null })
      return undefined
    }
    let active = true
    loadChatTitles(token)
      .then(({ permission, titles }) => {
        if (active) setChatInfo({ permission, title: titles.get(String(record.chat_id)) || null })
      })
      .catch(() => {
        if (active) setChatInfo({ permission: 'error', title: null })
      })
    return () => { active = false }
  }, [record?.chat_id, token])

  const currentVersion = Number(record?.current_version) || 1
  const previewVersion = selectedVersion || currentVersion
  const sourceKey = record ? `${record.id}:${previewVersion}` : ''
  const publicShare = useMemo(() => share ? { ...share, url: toPublicUrl(share.url) } : null, [share])
  const needsUpdate = shareNeedsUpdate(record, share)

  useEffect(() => {
    if (viewMode !== 'source' || !record) return undefined
    let active = true
    setSourceState({ key: sourceKey, status: 'loading', html: '', message: '' })
    storage.getText(versionPath(record.id, previewVersion))
      .then((html) => {
        if (!active) return
        if (html == null) throw new Error(`Version ${previewVersion} is missing.`)
        setSourceState({ key: sourceKey, status: 'ready', html, message: '' })
      })
      .catch((error) => {
        if (active) setSourceState({
          key: sourceKey,
          status: 'error',
          html: '',
          message: error?.message || 'Source could not be loaded.',
        })
      })
    return () => { active = false }
  }, [previewVersion, record?.id, sourceKey, sourceReloadTick, storage, viewMode])

  async function readVersionHtml(version) {
    const html = await storage.getText(versionPath(record.id, version))
    if (html == null) throw new Error(`Version ${version} is missing.`)
    return html
  }

  async function stageVersion(version) {
    const html = await readVersionHtml(version)
    const root = `projects/${record.id}/build/site`
    const preview = await renderArtifactLinkPreviewPng(record, version)
    await storage.removeFolder(root)
    const publishedHtml = injectArtifactStorageShim(html, { variant: 'published' })
    const saved = await Promise.all([
      storage.setText(`${root}/index.html`, publishedHtml),
      storage.setBlob(`${root}/${ARTIFACT_PREVIEW_FILENAME}`, preview),
    ])
    if (saved.some((result) => result?.queued)) {
      throw new Error('Connect to the internet before sharing this artifact.')
    }
  }

  async function stageLegacyMetadata(version, publicUrl) {
    const html = await readVersionHtml(version)
    const publishedHtml = injectArtifactStorageShim(html, { variant: 'published' })
    const withPreview = injectLegacyArtifactLinkPreview(
      publishedHtml,
      publicUrl,
      artifactLinkPreviewMetadata(record, version),
    )
    const saved = await storage.setText(
      `projects/${record.id}/build/site/index.html`,
      withPreview,
    )
    if (saved?.queued) {
      throw new Error('Connect to the internet before sharing this artifact.')
    }
  }

  function reflectLocalShare(next) {
    if (detailSyncRef.current) {
      detailSyncRef.current.acceptLocalShare(next)
    } else {
      setShare(next)
      setShareKnown(true)
    }
  }

  async function publish(version) {
    if (!record || busy) return
    setBusy('publish')
    const updating = Boolean(share?.published)
    try {
      await stageVersion(version)
      const metadata = artifactLinkPreviewMetadata(record, version)
      let result = await storage.publish(record.id, metadata)
      // Older Möbius releases do not yet add canonical metadata while making
      // the snapshot. They ignore link_preview and return no public_url, so
      // restage only the HTML once while keeping the same preview asset.
      if (!result.public_url) {
        await stageLegacyMetadata(version, toPublicUrl(result.url))
        result = await storage.publish(record.id, metadata)
      }
      // The snapshot is live now; that is the source of truth. Reflect it in
      // the UI immediately, then persist the share record BEST-EFFORT. If that
      // write fails, the platform already wrote a token hint into the project
      // that the detail synchronizer reads back — so there is nothing
      // to compensate, and the old rollback dance (which also mis-staged a
      // recovered share's null version) is gone.
      const next = publishedShare({
        id: record.id,
        version,
        token: result.token,
        url: result.public_url || result.url,
      })
      reflectLocalShare(next)
      showToast(updating ? `Shared version updated to v${version}.` : 'Public link created.', 'success')
      try {
        await storage.setJSON(`shares/${record.id}.json`, next)
      } catch { /* live + recoverable from the token hint; nothing to undo */ }
    } catch (error) {
      showToast(shareFailureMessage(error, 'Page could not be shared.'), 'error')
    } finally {
      setBusy('')
    }
  }

  async function stopSharing() {
    if (!record || busy) return
    setBusy('stop')
    try {
      await storage.unpublish(record.id)
      // The URL is dead now — reflect it before the metadata write so a failed
      // record save cannot leave the UI stuck showing a live share for a link
      // that is already gone.
      const next = stoppedShare(share)
      reflectLocalShare(next)
      showToast('Public link removed.', 'success')
      try {
        await storage.setJSON(`shares/${record.id}.json`, next)
      } catch { /* the link is down; a stale record self-heals on next load */ }
    } catch (error) {
      showToast(shareFailureMessage(error, 'Sharing could not be stopped.'), 'error')
    } finally {
      setBusy('')
    }
  }

  async function copyLink() {
    const url = publicShare?.url
    if (!url) return
    if (await copyPlainText(url)) {
      showToast('Public link copied.', 'success')
    } else {
      showToast('Copy is unavailable. Open the page and copy its address.', 'error')
    }
  }

  async function selectedHtml() {
    if (sourceState.key === sourceKey && sourceState.status === 'ready') return sourceState.html
    return readVersionHtml(previewVersion)
  }

  async function copyHtml() {
    if (!record || busy) return
    setBusy('copy')
    try {
      const html = await selectedHtml()
      if (!await copyPlainText(html)) throw new Error('clipboard unavailable')
      setOptionsOpen(false)
      showToast('Copied.', 'success')
    } catch {
      showToast('Copy is unavailable. Switch to Source and select the HTML.', 'error')
    } finally {
      setBusy('')
    }
  }

  async function downloadHtml() {
    if (!record || busy) return
    setBusy('download')
    try {
      const html = await selectedHtml()
      const blob = new Blob([html], { type: 'application/octet-stream' })
      const objectUrl = URL.createObjectURL(blob)
      try {
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = artifactFilename(record.title, previewVersion)
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      } finally {
        URL.revokeObjectURL(objectUrl)
      }
      setOptionsOpen(false)
      showToast('Download started.', 'success')
    } catch (error) {
      showToast(error?.message || 'HTML could not be downloaded.', 'error')
    } finally {
      setBusy('')
    }
  }

  async function deleteArtifact() {
    if (!record || busy) return
    setBusy('delete')
    try {
      if (!shareKnown || share?.published) {
        try {
          await storage.unpublish(record.id)
        } catch {
          showToast('Couldn\'t revoke the public link \u2014 try again', 'error')
          setBusy('')
          return
        }
      }
      await removePageStorage(storage, record.id)
      onDeleted(record.id)
    } catch (error) {
      showToast(error?.message || 'Page could not be deleted.', 'error')
      setBusy('')
    }
  }

  function openOriginChat() {
    if (!record?.chat_id) {
      showToast('The origin chat is no longer available.')
      return
    }
    if (chatInfo.permission === 'allowed' && !chatInfo.title) {
      showToast('The origin chat was deleted.')
      return
    }
    setOptionsOpen(false)
    postToShell({ type: 'moebius:open-chat', chatId: record.chat_id })
  }

  if (status === 'loading') {
    return <div className="af-detail-loading"><div className="af-skeleton af-skeleton-title" /><div className="af-skeleton af-skeleton-window" /></div>
  }

  if (status === 'missing' || status === 'error' || !record) {
    return (
      <div className="af-view">
        <header className="af-detail-header"><button className="af-btn af-btn-icon af-btn-ghost" type="button" onClick={onClose} aria-label="Back to pages"><ArrowLeftIcon /></button><h1>Page unavailable</h1></header>
        <div className="af-empty"><div className="af-empty-mark is-error">!</div><h2 className="af-empty-title">This page could not be found</h2><p className="af-empty-text">It may have been deleted while the catalog was open.</p><button className="af-btn af-btn-secondary" type="button" onClick={onClose}>Back to pages</button></div>
      </div>
    )
  }

  const deletedChat = chatInfo.permission === 'allowed' && !chatInfo.title
  const showChatTitle = chatInfo.permission !== 'forbidden'
  const fromLabel = chatInfo.permission === 'loading'
    ? 'Finding origin chat…'
    : deletedChat
      ? 'a deleted chat'
      : chatInfo.permission === 'error'
        ? 'chat title unavailable'
        : chatInfo.title

  return (
    <div className="af-view af-detail">
      <header className="af-detail-header">
        <button className="af-btn af-btn-icon af-btn-ghost" type="button" onClick={onClose} aria-label="Back to pages"><ArrowLeftIcon /></button>
        <button className="af-detail-heading" type="button" onClick={() => setVersionsOpen(true)} aria-label={`Choose page version, currently ${previewVersion}`}>
          <h1>{record.title || 'Untitled page'}</h1>
          <span>{previewVersion === currentVersion ? `v${currentVersion}` : `Viewing v${previewVersion}`}</span>
        </button>
        <div className="af-view-toggle" role="group" aria-label="Page view">
          <button className={viewMode === 'preview' ? 'is-active' : ''} type="button" aria-pressed={viewMode === 'preview'} aria-label="Preview" title="Preview" onClick={() => setViewMode('preview')}><EyeIcon size={20} /></button>
          <button className={viewMode === 'source' ? 'is-active' : ''} type="button" aria-pressed={viewMode === 'source'} aria-label="Source" title="Source" onClick={() => setViewMode('source')}><CodeIcon size={20} /></button>
        </div>
        <button className={`af-btn af-btn-icon af-btn-ghost af-header-action${needsUpdate ? ' has-update' : ''}`} type="button" onClick={() => setOptionsOpen(true)} aria-label="Page options"><MoreIcon /></button>
      </header>

      <main className="af-artifact-stage">
        {viewMode === 'preview'
          ? (
            <ArtifactFrame
              artifactId={record.id}
              version={previewVersion}
              storage={storage}
              onPreviewFrame={onPreviewFrame}
              writable={previewVersion === currentVersion}
            />
          )
          : (
            <div className="af-source" aria-label={`HTML source, version ${previewVersion}`}>
              {(sourceState.key !== sourceKey || sourceState.status === 'loading') && (
                <div className="af-source-state" aria-label="Loading page source"><div className="af-skeleton af-skeleton-window" /></div>
              )}
              {sourceState.key === sourceKey && sourceState.status === 'error' && (
                <div className="af-preview-error" role="status">
                  <div className="af-preview-error-mark" aria-hidden="true">!</div>
                  <strong>Source unavailable</strong>
                  <p>{sourceState.message}</p>
                  <button className="af-btn af-btn-secondary" type="button" onClick={() => setSourceReloadTick((n) => n + 1)}><ReloadIcon size={17} /> Reload</button>
                </div>
              )}
              {sourceState.key === sourceKey && sourceState.status === 'ready' && (
                <SourceViewer
                  value={sourceState.html}
                  docKey={sourceKey}
                  label={`HTML source, version ${previewVersion}`}
                />
              )}
            </div>
          )}
      </main>

      <ShareSheet open={shareOpen} artifact={record} share={publicShare} busy={Boolean(busy)} needsUpdate={needsUpdate} onClose={() => setShareOpen(false)} onPublish={publish} onCopy={copyLink} onStop={stopSharing} />
      <ArtifactOptionsSheet
        open={optionsOpen}
        busy={Boolean(busy)}
        description={record.description}
        originLabel={deletedChat ? 'Chat deleted' : showChatTitle && fromLabel ? `From: ${fromLabel}` : 'Return to the conversation'}
        originDisabled={deletedChat}
        shareLabel={share?.published ? 'Manage sharing' : 'Share'}
        shareDescription={share?.published ? (needsUpdate ? `Update public link to v${currentVersion}` : 'Public link is current') : 'Publish a public snapshot'}
        onClose={() => setOptionsOpen(false)}
        onShare={() => {
          setOptionsOpen(false)
          setShareOpen(true)
        }}
        onOpenOrigin={openOriginChat}
        onCopy={copyHtml}
        onDownload={downloadHtml}
        onDelete={() => {
          setOptionsOpen(false)
          setDeleteOpen(true)
        }}
      />
      <VersionSheet
        open={versionsOpen}
        versions={record.versions}
        currentVersion={currentVersion}
        selectedVersion={previewVersion}
        onSelect={(version) => setSelectedVersion(version === currentVersion ? null : version)}
        onClose={() => setVersionsOpen(false)}
      />
      <DeleteSheet open={deleteOpen} title={record.title} busy={busy === 'delete'} onClose={() => setDeleteOpen(false)} onDelete={deleteArtifact} />
      {toast && <div className={`af-toast${toast.tone ? ` is-${toast.tone}` : ''}`} role="status" key={toast.key}>{toast.message}</div>}
    </div>
  )
}
