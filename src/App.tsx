import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react'
import {
  Aperture,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
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
  Search,
  SlidersHorizontal,
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
}

function App() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [activePhoto, setActivePhoto] = useState(0)
  const [view, setView] = useState<'library' | 'edit'>('library')
  const [isDragging, setIsDragging] = useState(false)
  const [adjustments, setAdjustments] = useState({ exposure: 0, contrast: 0, temperature: 0, tint: 0 })
  const [zoom, setZoom] = useState(1)
  const [showBefore, setShowBefore] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const photoUrls = useRef<string[]>([])
  const selectedPhoto = photos[activePhoto]

  useEffect(() => () => photoUrls.current.forEach((url) => URL.revokeObjectURL(url)), [])

  const importFiles = (files: File[]) => {
    const imported = files.filter((file) => file.type.startsWith('image/')).map((file) => {
      const src = URL.createObjectURL(file)
      photoUrls.current.push(src)
      return {
      src,
      title: file.name.replace(/\.[^/.]+$/, ''),
      location: 'Imported photo',
      fileName: file.name,
      kind: file.name.toLowerCase().endsWith('.raw') ? 'RAW' as const : 'JPG' as const,
      }
    })
    if (imported.length === 0) return
    setPhotos((current) => [...current, ...imported])
    setActivePhoto(photos.length)
    setView('library')
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    importFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    importFiles(Array.from(event.dataTransfer.files))
  }

  const updateAdjustment = (name: keyof typeof adjustments, value: number) => {
    setAdjustments((current) => ({ ...current, [name]: value }))
  }

  const previewFilter = `brightness(${100 + adjustments.exposure * 0.55}%) contrast(${100 + adjustments.contrast * 0.5}%) saturate(${100 + adjustments.temperature * 0.22}%) sepia(${Math.max(0, adjustments.temperature) * 0.0025}%) hue-rotate(${adjustments.tint * 0.18}deg)`

  const resetAdjustments = () => setAdjustments({ exposure: 0, contrast: 0, temperature: 0, tint: 0 })

  if (view === 'edit' && selectedPhoto) {
    return (
      <main className="develop-shell">
        <header className="develop-topbar">
          <div className="develop-brand"><Aperture size={19} /><strong>sharply</strong><span>DEVELOP</span></div>
          <div className="develop-photo-name"><span>{activePhoto + 1} / {photos.length}</span><strong>{selectedPhoto.title}</strong></div>
          <div className="develop-actions"><button className="develop-back" onClick={() => setView('library')}><ArrowLeft size={15} /> Library</button><button className="icon-button" onClick={resetAdjustments} title="Reset adjustments"><RotateCcw size={16} /></button><button className="apply-button" onClick={() => setView('library')}><Check size={15} /> Done</button></div>
        </header>
        <section className="develop-stage">
          <div className="canvas-toolbar"><div className="canvas-context"><span className="eyebrow">Local import</span><span>{selectedPhoto.fileName}</span></div><div className="canvas-tools"><button className={showBefore ? 'tool-button active' : 'tool-button'} onClick={() => setShowBefore((current) => !current)}>Before</button><button className={zoom === 1 ? 'tool-button active' : 'tool-button'} onClick={() => setZoom(1)}>Fit</button><button className={zoom === 1.5 ? 'tool-button active' : 'tool-button'} onClick={() => setZoom(1.5)}>100%</button><button className="icon-button" onClick={() => setZoom((current) => Math.max(.7, current - .1))}><Minus size={15} /></button><span className="zoom-label">{Math.round(zoom * 100)}%</span><button className="icon-button" onClick={() => setZoom((current) => Math.min(2, current + .1))}><Plus size={15} /></button><button className="icon-button" title="Fullscreen canvas"><Maximize2 size={15} /></button></div></div>
          <div className="develop-canvas"><img style={{ filter: showBefore ? 'none' : previewFilter, transform: `scale(${zoom})` }} src={selectedPhoto.src} alt={selectedPhoto.title} /><div className="canvas-badge">{showBefore ? 'Before' : 'Live preview'}</div></div>
          <div className="filmstrip"><button className="film-import" onClick={() => fileInputRef.current?.click()}><ImagePlus size={18} /><span>Import</span></button>{photos.map((photo, index) => <button className={`film-thumb ${activePhoto === index ? 'active' : ''}`} key={`${photo.fileName}-film-${index}`} onClick={() => { setActivePhoto(index); setShowBefore(false) }}><img src={photo.src} alt={photo.title} /><span>{index + 1}</span></button>)}</div>
        </section>
        <aside className="develop-panel"><div className="panel-heading"><div><span className="eyebrow">Develop</span><h1>Basic</h1></div><span className="raw-label">{selectedPhoto.kind}</span></div><div className="develop-section"><div className="section-heading"><span>Light</span><button onClick={resetAdjustments}>Reset</button></div>{([['exposure', 'Exposure'], ['contrast', 'Contrast']] as const).map(([name, label]) => <label className="develop-adjustment" key={name}><span>{label}</span><input type="range" min="-100" max="100" value={adjustments[name]} onChange={(event) => updateAdjustment(name, Number(event.target.value))} /><output>{adjustments[name] > 0 ? '+' : ''}{adjustments[name]}</output></label>)}</div><div className="develop-section"><div className="section-heading"><span>Color</span></div>{([['temperature', 'Temperature'], ['tint', 'Tint']] as const).map(([name, label]) => <label className="develop-adjustment" key={name}><span>{label}</span><input type="range" min="-100" max="100" value={adjustments[name]} onChange={(event) => updateAdjustment(name, Number(event.target.value))} /><output>{adjustments[name] > 0 ? '+' : ''}{adjustments[name]}</output></label>)}</div><div className="develop-section detail-section"><div className="section-heading"><span>Detail</span><ChevronDown size={14} /></div><p>Sharpening and noise reduction controls will be added here.</p></div><div className="develop-panel-footer"><span>Changes are preview-only</span><button onClick={() => setView('library')}>Return to Library</button></div></aside>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark"><Aperture size={20} strokeWidth={2.4} /><span>sharply</span><small>PHOTO EDITOR</small></div>
        <button className="import-button" onClick={() => fileInputRef.current?.click()}><ImagePlus size={16} /> Import photos <span>+</span></button>
        <input ref={fileInputRef} className="file-input" type="file" accept="image/*,.raw,.dng,.cr2,.nef,.arw" multiple onChange={handleFileChange} />

        <nav className="primary-nav" aria-label="Primary navigation">
          <button className="nav-item active"><Grid2X2 size={17} /> Library <span>{photos.length}</span></button>
          <button className="nav-item" disabled={!selectedPhoto} onClick={() => setView('edit')}><SlidersHorizontal size={17} /> Develop</button>
          <button className="nav-item"><Cloud size={17} /> Cloud sync <span className="sync-dot" /></button>
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
          <div className="top-actions"><button className="icon-button"><Search size={17} /></button><button className="icon-button"><Menu size={17} /></button><div className="avatar">SC</div></div>
        </header>

        <div className="content-area">
          <div className="content-header">
            <div><p className="eyebrow">Library / {photos.length} {photos.length === 1 ? 'photo' : 'photos'}</p><h1>Recent imports</h1></div>
            <div className="header-actions"><button className="outline-button" disabled={!selectedPhoto}><Tag size={15} /> Add tags</button><button className="solid-button" disabled={!selectedPhoto}><Upload size={15} /> Export</button></div>
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
          <div className="adjustment-heading"><span>Basic adjustments</span><button onClick={() => setAdjustments({ exposure: 0, contrast: 0, temperature: 0, tint: 0 })}>Reset</button></div>
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
