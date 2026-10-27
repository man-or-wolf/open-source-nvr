import React from 'react'
import { Modal, Stack, Dropdown, TextField, DefaultButton, PrimaryButton, Text, TagPicker } from '@fluentui/react'

// Draw polygons (normalised 0-1 coords) over a camera snapshot.
// kinds: zone (objects only count inside), motion_mask (ignore motion), object_mask (ignore detections)
const KINDS = [
    { key: 'zones', text: 'Zone (objects must be inside)', color: '#2e9e44' },
    { key: 'motion_mask', text: 'Motion mask (ignore motion)', color: '#d9822b' },
    { key: 'object_mask', text: 'Object mask (ignore detections)', color: '#c0392b' }
]

const clamp = (n) => Math.min(1, Math.max(0, Math.round(n * 1000) / 1000))

export function ZoneEditor({ cameraKey, value, objectNames, onSave, onDismiss }) {
    const [data, setData] = React.useState({ zones: value.zones || [], motion_mask: value.motion_mask || [], object_mask: value.object_mask || [] })
    const [kind, setKind] = React.useState('zones')
    const [zoneName, setZoneName] = React.useState('')
    const [zoneObjects, setZoneObjects] = React.useState([])
    const [points, setPoints] = React.useState([])
    const [imgError, setImgError] = React.useState(false)
    const svgRef = React.useRef(null)

    function addPoint(ev) {
        const r = svgRef.current.getBoundingClientRect()
        setPoints(p => p.concat([[clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height)]]))
    }

    function closePolygon() {
        if (points.length < 3) return
        if (kind === 'zones') {
            const name = zoneName || `zone${data.zones.length + 1}`
            setData({ ...data, zones: data.zones.concat({ name, points, ...(zoneObjects.length > 0 && { objects: zoneObjects }) }) })
            setZoneName('')
        } else {
            setData({ ...data, [kind]: data[kind].concat([points]) })
        }
        setPoints([])
    }

    const remove = (k, idx) => setData({ ...data, [k]: data[k].filter((_, i) => i !== idx) })
    const poly = (pts) => pts.map(p => p.join(',')).join(' ')
    const color = (k) => KINDS.find(x => x.key === k).color

    return (
        <Modal isOpen onDismiss={onDismiss} isBlocking styles={{ main: { padding: 16, maxWidth: 'min(900px, 96vw)' } }}>
            <Stack tokens={{ childrenGap: 10 }}>
                <Text variant="large">Zones and masks</Text>
                <Text>Click the image to add points, then "Close shape". Zones limit which areas can start an event; masks ignore noisy areas (trees, timestamps).</Text>
                <div style={{ position: 'relative', lineHeight: 0 }}>
                    <img src={`/api/snapshot/${cameraKey}`} alt="camera" style={{ width: '100%', display: 'block', minHeight: 120, background: '#222' }} onError={() => setImgError(true)} />
                    <svg ref={svgRef} viewBox="0 0 1 1" preserveAspectRatio="none" onClick={addPoint}
                        style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', cursor: 'crosshair' }}>
                        {KINDS.map(k => (data[k.key] || []).map((item, i) => (
                            <polygon key={`${k.key}${i}`} points={poly(k.key === 'zones' ? item.points : item)} fill={k.color} fillOpacity="0.3" stroke={k.color} strokeWidth="0.004" vectorEffect="non-scaling-stroke" />
                        )))}
                        {points.length > 0 && <polyline points={poly(points)} fill="none" stroke={color(kind)} strokeWidth="0.006" />}
                        {points.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="0.006" fill="#fff" stroke={color(kind)} strokeWidth="0.002" />)}
                    </svg>
                </div>
                {imgError && <Text styles={{ root: { color: 'red' } }}>No snapshot available (is streaming enabled and the camera reachable?). You can still save existing shapes.</Text>}
                <Stack horizontal wrap tokens={{ childrenGap: 10 }} verticalAlign="end">
                    <Dropdown label="Draw" selectedKey={kind} options={KINDS} onChange={(ev, o) => { setKind(o.key); setPoints([]) }} styles={{ root: { minWidth: 260 } }} />
                    {kind === 'zones' && <TextField label="Zone name" value={zoneName} onChange={(ev, v) => setZoneName(v)} />}
                    <DefaultButton text="Close shape" disabled={points.length < 3} onClick={closePolygon} />
                    <DefaultButton text="Undo point" disabled={points.length === 0} onClick={() => setPoints(points.slice(0, -1))} />
                </Stack>
                {kind === 'zones' &&
                    <TagPicker
                        onChange={(i) => setZoneObjects((i || []).map(x => x.key))}
                        removeButtonAriaLabel="Remove"
                        onResolveSuggestions={(f) => f ? objectNames.filter(n => n.name.toLowerCase().startsWith(f.toLowerCase()) && !zoneObjects.includes(n.key)) : []}
                        getTextFromItem={(i) => i.name}
                        inputProps={{ placeholder: 'Only these objects in this zone (empty = all tracked)' }} />}
                <Stack tokens={{ childrenGap: 4 }}>
                    {KINDS.map(k => (data[k.key] || []).map((item, i) => (
                        <Stack horizontal key={`${k.key}${i}`} verticalAlign="center" tokens={{ childrenGap: 8 }}>
                            <span style={{ width: 12, height: 12, background: k.color, display: 'inline-block' }} />
                            <Text>{k.key === 'zones' ? `Zone "${item.name}"${item.objects ? ` (${item.objects.join(', ')})` : ''}` : k.text.split(' (')[0]}</Text>
                            <DefaultButton text="Remove" onClick={() => remove(k.key, i)} />
                        </Stack>
                    )))}
                </Stack>
                <Stack horizontal tokens={{ childrenGap: 10 }}>
                    <PrimaryButton text="Apply" onClick={() => onSave(data)} />
                    <DefaultButton text="Cancel" onClick={onDismiss} />
                </Stack>
            </Stack>
        </Modal>
    )
}
