import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Aperture,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Crop,
  Command,
  Folder,
  Grid2X2,
  Heart,
  ImagePlus,
  LayoutPanelLeft,
  Menu,
  PanelRight,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tag,
  Upload,
} from 'lucide-react'

type Photo = {
  src: string
  title: string
  location: string
  fileName: string
  kind: 'RAW' | 'JPG'
  rawBytes?: Uint8Array
  cameraMake?: string
  cameraModel?: string
  profile?: string
}

type CameraProfileKey = 'auto' | 'canon' | 'nikon' | 'sony'
type RawDecodeResponse = { png: number[]; camera_make: string; camera_model: string; profile: string }

type Adjustments = {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  temperature: number
  tint: number
  texture: number
  clarity: number
  dehaze: number
  vibrance: number
  saturation: number
  sharpening: number
  noiseReduction: number
  vignette: number
}

const initialAdjustments: Adjustments = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temperature: 0, tint: 0, texture: 0, clarity: 0, dehaze: 0, vibrance: 0,
  saturation: 0, sharpening: 0, noiseReduction: 0, vignette: 0,
}

function App() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [activePhoto, setActivePhoto] = useState(0)
  const [view, setView] = useState<'library' | 'edit'>('library')
  const [isDragging, setIsDragging] = useState(false)
  const [adjustments, setAdjustments] = useState<Adjustments>(initialAdjustments)
  const [zoom, setZoom] = useState(1)
  const [showBefore, setShowBefore] = useState(false)
  const [rotation, setRotation] = useState(0)
  const [crop, setCrop] = useState<'original' | 'square' | 'portrait' | 'wide'>('original')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [importError, setImportError] = useState('')
  const [importStatus, setImportStatus] = useState('')
  const [cameraProfile, setCameraProfile] = useState<CameraProfileKey>('auto')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const photoUrls = useRef<string[]>([])
  const selectedPhoto = photos[activePhoto]

  useEffect(() => () => photoUrls.current.forEach((url) => URL.revokeObjectURL(url)), [])

  const importFiles = async (files: File[]) => {
    setImportError('')
    const candidates = files.filter((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      const isRaw = ['cr1', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng'].includes(extension)
      return isRaw || file.type.startsWith('image/')
    })
    let importedCount = 0
    let completed = 0
    setImportStatus(candidates.length > 1 ? `Importing 0 of ${candidates.length} photos...` : '')
    for (const file of candidates) {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      const isRaw = ['cr1', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng'].includes(extension)
      try {
        let src: string
        let rawBytes: Uint8Array | undefined
        let rawDetails: Omit<RawDecodeResponse, 'png'> | undefined
        if (isRaw) {
          rawBytes = new Uint8Array(await file.arrayBuffer())
          const decoded = await invoke<RawDecodeResponse>('decode_raw', { bytes: Array.from(rawBytes), profile: cameraProfile })
          rawDetails = decoded
          src = URL.createObjectURL(new Blob([new Uint8Array(decoded.png)], { type: 'image/png' }))
        } else {
          src = URL.createObjectURL(file)
        }
        photoUrls.current.push(src)
        const importedPhoto: Photo = {
          src,
          title: file.name.replace(/\.[^/.]+$/, ''),
          location: isRaw ? `${rawDetails?.camera_make ?? 'Camera'} RAW import` : 'Imported photo',
          fileName: file.name,
          kind: isRaw ? 'RAW' : 'JPG',
          rawBytes,
          cameraMake: rawDetails?.camera_make,
          cameraModel: rawDetails?.camera_model,
          profile: rawDetails?.profile,
        }
        setPhotos((current) => [...current, importedPhoto])
        setActivePhoto((current) => current === 0 && importedCount === 0 ? 0 : current)
        importedCount += 1
      } catch (error) {
        setImportError((current) => current ? `${current} | ${file.name}: ${String(error)}` : `${file.name}: ${String(error)}`)
      } finally {
        completed += 1
        if (candidates.length > 1) setImportStatus(`Importing ${completed} of ${candidates.length} photos...`)
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      }
    }
    setImportStatus('')
    if (importedCount === 0) return
    setView('library')
  }

  const changeCameraProfile = async (nextProfile: CameraProfileKey) => {
    setCameraProfile(nextProfile)
    if (!selectedPhoto?.rawBytes) return
    setImportError('')
    setImportStatus(`Applying ${nextProfile === 'auto' ? 'camera' : nextProfile} profile...`)
    try {
      const decoded = await invoke<RawDecodeResponse>('decode_raw', { bytes: Array.from(selectedPhoto.rawBytes), profile: nextProfile })
      const src = URL.createObjectURL(new Blob([new Uint8Array(decoded.png)], { type: 'image/png' }))
      photoUrls.current.push(src)
      setPhotos((current) => current.map((photo, index) => index === activePhoto ? { ...photo, src, cameraMake: decoded.camera_make, cameraModel: decoded.camera_model, profile: decoded.profile } : photo))
      URL.revokeObjectURL(selectedPhoto.src)
      photoUrls.current = photoUrls.current.filter((url) => url !== selectedPhoto.src)
    } catch (error) {
      setImportError(`Could not apply camera profile: ${String(error)}`)
    } finally {
      setImportStatus('')
    }
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void importFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    void importFiles(Array.from(event.dataTransfer.files))
  }

  const previewFilter = `brightness(${100 + adjustments.exposure * 0.55 + adjustments.highlights * 0.1 + adjustments.shadows * 0.08 + adjustments.whites * 0.12 + adjustments.blacks * 0.06}%) contrast(${100 + adjustments.contrast * 0.5 + adjustments.clarity * 0.18 + adjustments.dehaze * 0.16 + adjustments.sharpening * 0.12 + adjustments.whites * 0.14 - adjustments.blacks * 0.12}%) saturate(${100 + adjustments.vibrance * 0.42 + adjustments.saturation * 0.7 + adjustments.texture * 0.12}%) sepia(${Math.abs(adjustments.temperature) * 0.0025}%) hue-rotate(${adjustments.temperature * 0.12 + adjustments.tint * 0.18}deg) blur(${Math.max(0, adjustments.noiseReduction) * 0.012}px)`

  const resetAdjustments = () => {
    setAdjustments(initialAdjustments)
    setRotation(0)
    setCrop('original')
  }

  const updateAdjustment = (name: keyof Adjustments, value: number) => {
    setAdjustments((current) => ({ ...current, [name]: value }))
  }

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      setIsFullscreen(false)
      return
    }
    await document.documentElement.requestFullscreen()
    setIsFullscreen(true)
  }

  const exportPhoto = () => {
    if (!selectedPhoto) return
    const image = new Image()
    image.src = selectedPhoto.src
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) return
      context.filter = previewFilter
      context.translate(canvas.width / 2, canvas.height / 2)
      context.rotate((rotation * Math.PI) / 180)
      context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2)
      const link = document.createElement('a')
      link.download = `${selectedPhoto.title}-sharply.jpg`
      link.href = canvas.toDataURL('image/jpeg', 0.92)
      link.click()
    }
  }

  if (view === 'edit' && selectedPhoto) {
    return (
      <main className="develop-shell">
        <header className="develop-topbar">
          <div className="develop-brand"><Aperture size={19} /><strong>sharply</strong><span>DEVELOP</span></div>
          <div className="develop-photo-name"><span>{activePhoto + 1} / {photos.length}</span><strong>{selectedPhoto.title}</strong></div>
          <div className="develop-actions"><button className="develop-back" onClick={() => setView('library')}><ArrowLeft size={15} /> Library</button><button className="icon-button" onClick={resetAdjustments} title="Reset adjustments"><RotateCcw size={16} /></button><button className="apply-button" onClick={() => setView('library')}><Check size={15} /> Done</button></div>
        </header>
        <section className="develop-stage">
          <div className="canvas-toolbar"><div className="canvas-context"><span className="eyebrow">Local import</span><span>{selectedPhoto.fileName}</span></div><div className="canvas-tools"><button className={showBefore ? 'tool-button active' : 'tool-button'} onClick={() => setShowBefore((current) => !current)}>Before</button><button className={zoom === 1 ? 'tool-button active' : 'tool-button'} onClick={() => setZoom(1)}>Fit</button><button className={zoom === 1.5 ? 'tool-button active' : 'tool-button'} onClick={() => setZoom(1.5)}>100%</button><button className="icon-button" onClick={() => setZoom((current) => Math.max(.7, current - .1))}><Minus size={15} /></button><span className="zoom-label">{Math.round(zoom * 100)}%</span><button className="icon-button" onClick={() => setZoom((current) => Math.min(2, current + .1))}><Plus size={15} /></button><button className="icon-button" onClick={() => setRotation((current) => current + 90)} title="Rotate 90 degrees"><RotateCw size={15} /></button><button className="icon-button" onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen canvas'}><Maximize2 size={15} /></button></div></div>
          <div className={`develop-canvas crop-${crop}`}><img style={{ filter: showBefore ? 'none' : previewFilter, transform: `scale(${zoom}) rotate(${rotation}deg)` }} src={selectedPhoto.src} alt={selectedPhoto.title} /><div className="vignette-overlay" style={{ opacity: Math.max(0, adjustments.vignette) / 140 }} /><div className="canvas-badge">{showBefore ? 'Before' : 'Live preview'}</div></div>
          <div className="filmstrip"><button className="film-import" onClick={() => fileInputRef.current?.click()}><ImagePlus size={18} /><span>Import</span></button>{photos.map((photo, index) => <button className={`film-thumb ${activePhoto === index ? 'active' : ''}`} key={`${photo.fileName}-film-${index}`} onClick={() => { setActivePhoto(index); setShowBefore(false) }}><img src={photo.src} alt={photo.title} /><span>{index + 1}</span></button>)}</div>
        </section>
        <aside className="develop-panel"><div className="panel-heading"><div><span className="eyebrow">Develop</span><h1>Basic</h1></div><span className="raw-label">{selectedPhoto.kind}</span></div><div className="develop-section"><div className="section-heading"><span>Tone</span><button onClick={resetAdjustments}>Reset</button></div>{([['exposure', 'Exposure'], ['contrast', 'Contrast'], ['highlights', 'Highlights'], ['shadows', 'Shadows'], ['whites', 'Whites'], ['blacks', 'Blacks']] as const).map(([name, label]) => <label className="develop-adjustment" key={name}><span>{label}</span><input type="range" min="-100" max="100" value={adjustments[name]} onChange={(event) => updateAdjustment(name, Number(event.target.value))} /><output>{adjustments[name] > 0 ? '+' : ''}{adjustments[name]}</output></label>)}</div><div className="develop-section"><div className="section-heading"><span>Color</span></div>{selectedPhoto.kind === 'RAW' && <label className="develop-adjustment profile-adjustment"><span>Camera profile</span><select value={cameraProfile} onChange={(event) => void changeCameraProfile(event.target.value as CameraProfileKey)}><option value="auto">Auto (camera)</option><option value="canon">Canon Camera Color</option><option value="nikon">Nikon Camera Color</option><option value="sony">Sony Camera Color</option></select><output title={selectedPhoto.profile}>{selectedPhoto.profile?.replace(' Camera Color', '') ?? 'Embedded'}</output></label>}{([['temperature', 'Temperature'], ['tint', 'Tint'], ['vibrance', 'Vibrance'], ['saturation', 'Saturation']] as const).map(([name, label]) => <label className="develop-adjustment" key={name}><span>{label}</span><input type="range" min="-100" max="100" value={adjustments[name]} onChange={(event) => updateAdjustment(name, Number(event.target.value))} /><output>{adjustments[name] > 0 ? '+' : ''}{adjustments[name]}</output></label>)}</div><div className="develop-section"><div className="section-heading"><span>Presence</span><Sparkles size={14} /></div>{([['texture', 'Texture'], ['clarity', 'Clarity'], ['dehaze', 'Dehaze']] as const).map(([name, label]) => <label className="develop-adjustment" key={name}><span>{label}</span><input type="range" min="-100" max="100" value={adjustments[name]} onChange={(event) => updateAdjustment(name, Number(event.target.value))} /><output>{adjustments[name] > 0 ? '+' : ''}{adjustments[name]}</output></label>)}</div><div className="develop-section"><div className="section-heading"><span>Detail</span><ChevronDown size={14} /></div>{([['sharpening', 'Sharpening'], ['noiseReduction', 'Noise reduction']] as const).map(([name, label]) => <label className="develop-adjustment" key={name}><span>{label}</span><input type="range" min="0" max="100" value={adjustments[name]} onChange={(event) => updateAdjustment(name, Number(event.target.value))} /><output>{adjustments[name]}</output></label>)}</div><div className="develop-section"><div className="section-heading"><span>Effects</span></div><label className="develop-adjustment"><span>Vignette</span><input type="range" min="0" max="100" value={adjustments.vignette} onChange={(event) => updateAdjustment('vignette', Number(event.target.value))} /><output>{adjustments.vignette}</output></label></div><div className="develop-section crop-controls"><div className="section-heading"><span><Crop size={14} /> Crop & rotate</span></div><div className="crop-buttons">{([['original', 'Original'], ['square', '1:1'], ['portrait', '4:5'], ['wide', '16:9']] as const).map(([value, label]) => <button className={crop === value ? 'tool-button active' : 'tool-button'} key={value} onClick={() => setCrop(value)}>{label}</button>)}<button className="tool-button" onClick={() => setRotation((current) => current + 90)}><RotateCw size={13} /> Rotate</button></div></div><div className="develop-panel-footer"><span>Non-destructive preview</span><button onClick={() => setView('library')}>Return to Library</button></div></aside>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark"><Aperture size={20} strokeWidth={2.4} /><span>sharply</span><small>PHOTO EDITOR</small></div>
        <button className="import-button" disabled={Boolean(importStatus)} onClick={() => fileInputRef.current?.click()}><ImagePlus size={16} /> {importStatus ? 'Importing...' : 'Import photos'} <span>+</span></button>
        <input ref={fileInputRef} className="file-input" type="file" accept="image/*,.raw,.dng,.cr2,.nef,.arw" multiple onChange={handleFileChange} />

        <nav className="primary-nav" aria-label="Primary navigation">
          <button className="nav-item active" onClick={() => setView('library')}><Grid2X2 size={17} /> Library <span>{photos.length}</span></button>
          <button className="nav-item" disabled={!selectedPhoto} onClick={() => setView('edit')}><SlidersHorizontal size={17} /> Develop</button>
        </nav>

        <div className="sidebar-section">
          <div className="section-label">Catalog <ChevronDown size={14} /></div>
          <button className="collection-item"><Folder size={16} /> All photos <span>{photos.length}</span></button>
          <button className="collection-item"><Star size={16} /> Rated <span>0</span></button>
          <button className="collection-item"><Heart size={16} /> Favorites <span>0</span></button>
        </div>
        <div className="sidebar-section">
          <div className="section-label">Collections <ChevronDown size={14} /></div>
          <button className="collection-item"><span className="folder-swatch ochre" /> Recent imports <span>{photos.length}</span></button>
          <button className="new-collection"><span>+</span> New collection</button>
        </div>

        <div className="sidebar-footer">
          <button className="footer-button"><CircleHelp size={16} /> Help center</button>
          <div className="storage"><div><span>Local storage</span><strong>{photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : 'No photos yet'}</strong></div><div className="storage-track"><span style={{ width: `${Math.min(photos.length * 4, 100)}%` }} /></div></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="crumb"><span>Sharply / Library</span><ChevronRight size={14} /><strong>{photos.length ? 'Recent imports' : 'No collection selected'}</strong></div>
          <div className="top-actions"><button className="icon-button" onClick={() => setSearchOpen((current) => !current)} title="Search imports"><Search size={17} /></button><button className="icon-button" onClick={toggleFullscreen} title="Fullscreen app"><Menu size={17} /></button><div className="avatar">SC</div></div>
        </header>

        {searchOpen && <div className="search-popover"><Search size={15} /><input autoFocus placeholder="Search imported photos" onChange={(event) => { const query = event.target.value.toLowerCase(); if (query) setActivePhoto(Math.max(0, photos.findIndex((photo) => photo.fileName.toLowerCase().includes(query)))) }} /></div>}

        <div className="content-area">
          {importStatus && <div className="import-progress" role="status">{importStatus}</div>}
          {importError && <div className="import-error" role="alert">Could not import RAW file. {importError}</div>}
          <div className="content-header">
            <div><p className="eyebrow">Library / {photos.length} {photos.length === 1 ? 'photo' : 'photos'}</p><h1>Recent imports</h1></div>
            <div className="header-actions"><button className="outline-button" disabled={!selectedPhoto} onClick={() => window.prompt('Add a keyword to this photo') }><Tag size={15} /> Add tags</button><button className="solid-button" disabled={!selectedPhoto} onClick={exportPhoto}><Upload size={15} /> Export</button></div>
          </div>

          <div className="toolbar"><div className="filter-group"><button className="filter active">All <span>{photos.length}</span></button><button className="filter">Unrated <span>{photos.length}</span></button><button className="filter">Flagged <span>0</span></button></div><div className="view-options"><button className="view-button active"><Grid2X2 size={16} /></button><button className="view-button"><LayoutPanelLeft size={16} /></button><span className="sort-label">Sort by <strong>Import date</strong><ChevronDown size={14} /></span></div></div>

          <div className={`photo-grid ${isDragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }} onDragLeave={() => setIsDragging(false)} onDrop={handleDrop}>
            {photos.length ? photos.map((photo, index) => <button className={`photo-card ${activePhoto === index ? 'selected' : ''}`} key={`${photo.fileName}-${index}`} onClick={() => setActivePhoto(index)}><img src={photo.src} alt={photo.title} /><span className="photo-badge">{photo.kind}</span><span className="photo-caption"><strong>{photo.title}</strong><small>{photo.location}</small></span></button>) : <div className="empty-library"><ImagePlus size={27} /><h2>Your library is empty</h2><p>Import photos from your computer to start editing.</p><button className="solid-button" onClick={() => fileInputRef.current?.click()}><Upload size={15} /> Choose photos</button><span>or drag image files here</span></div>}
          </div>
        </div>
      </section>

      <aside className={`inspector ${view === 'edit' ? 'editing' : ''} ${!selectedPhoto ? 'empty-inspector' : ''}`}>
        {selectedPhoto ? <><div className="inspector-head"><div><span className="eyebrow">Selected photo</span><h2>{selectedPhoto.title}</h2></div><button className="icon-button"><PanelRight size={17} /></button></div>
        <div className="preview-frame"><img className="inspector-image" style={{ filter: previewFilter }} src={selectedPhoto.src} alt={selectedPhoto.title} />{view === 'edit' && <span className="preview-state">Live preview</span>}</div>
        <button className="develop-button" onClick={() => setView(view === 'edit' ? 'library' : 'edit')}><SlidersHorizontal size={16} /> {view === 'edit' ? 'Back to Library' : 'Open in Develop'} <Command size={14} /><span>D</span></button>
        {view === 'edit' && <div className="adjustment-panel">
          <div className="adjustment-heading"><span>Basic adjustments</span><button onClick={resetAdjustments}>Reset</button></div>
          {([['exposure', 'Exposure'], ['contrast', 'Contrast'], ['temperature', 'Temperature'], ['tint', 'Tint']] as const).map(([name, label]) => <label className="adjustment" key={name}><span>{label}</span><input type="range" min="-100" max="100" value={adjustments[name]} onChange={(event) => updateAdjustment(name, Number(event.target.value))} /><output>{adjustments[name] > 0 ? '+' : ''}{adjustments[name]}</output></label>)}
        </div>}
        <div className="inspector-block"><div className="metadata-row"><span>File</span><strong>{selectedPhoto.fileName}</strong></div><div className="metadata-row"><span>Source</span><strong>Local import</strong></div><div className="metadata-row"><span>Format</span><strong>{selectedPhoto.kind}</strong></div></div>
        <div className="inspector-block keywords"><div className="block-title"><span>Keywords</span><button>+ Add</button></div><div className="keyword-list"><span>mountains</span><span>morning</span><span>mist</span></div></div>
        <div className="inspector-block rating"><div className="block-title"><span>Rating</span><span className="stars">★★★★★</span></div></div>
        </> : <div className="inspector-empty"><PanelRight size={26} /><span>No photo selected</span><small>Import an image to inspect and edit it.</small></div>}
      </aside>
    </main>
  )
}

export default App
