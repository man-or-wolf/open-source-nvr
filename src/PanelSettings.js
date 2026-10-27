import React  from 'react';
import {  Text, DefaultButton, Dropdown, Stack, TextField, Slider, TagPicker, Separator, Label, MessageBar, MessageBarType, Checkbox, PrimaryButton, Panel } from '@fluentui/react'
import { ZoneEditor } from './ZoneEditor.js'


const cocoNames= [
    "person",
    "bicycle",
    "car",
    "motorbike",
    "aeroplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "sofa",
    "pottedplant",
    "bed",
    "diningtable",
    "toilet",
    "tvmonitor",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush"
    // names used by the TFLite/Coral model that differ from darknet
    ].concat(["motorcycle", "airplane", "couch", "potted plant", "dining table", "tv"])
    .map(item => ({ key: item, name: item }));

const detectorTypes = [
    { key: 'none', text: 'None (camera motion + optional darknet below)' },
    { key: 'edgetpu', text: 'Google Coral TPU (EdgeTPU)' },
    { key: 'cpu', text: 'CPU (TensorFlow Lite, slow)' },
    { key: 'mock', text: 'Test only (detects white objects)' }
]



export function PanelSettings({panel, setPanel, data, getServerData}) {

    const [error, setError] = React.useState(null)
    const [zoneEditor, setZoneEditor] = React.useState(false)

    function updatePanelValues(field, value) {
        var calcFolder = panel.values.folder || ''
        if (field === "name") {
          if (!calcFolder) {
            calcFolder = value
          } else if (calcFolder.includes(panel.values.name)) {
            calcFolder = calcFolder.replace(panel.values.name, value)
          }
        }
    
    
        setPanel({...panel, values: {...panel.values, 
          [field]: value, 
          ...(field === "enable_streaming" && value === false && {enable_movement: false}),
          ...(field !== 'folder' && panel.key !== 'settings' && {folder: calcFolder})
        }})
    }

    function getError(field) {
        const idx = panel.invalidArray.findIndex(e => e.field === field)
        return idx >= 0 ? panel.invalidArray[idx].message : ''
    }

    function invalidFn(field, invalid, message) {
        const e = panel.invalidArray.find(e => e.field === field)
        if (!invalid && e) {
          setPanel((prev) => {return {...prev, invalidArray: prev.invalidArray.filter((e) => e.field !== field)}})
        } else if (invalid && !e) {
          setPanel((prev) => {return {...prev, invalidArray: prev.invalidArray.concat({ field, message })}})
        }
      }
    
      if (panel.open) {
    
        if (panel.key === 'settings') {
          invalidFn('disk_base_dir', !panel.values.disk_base_dir || panel.values.disk_base_dir.endsWith('/') || !panel.values.disk_base_dir.startsWith('/'),
            <Text>Must be abosolute path (cannot end with '/')</Text>)
          invalidFn('detector_model', (panel.values.detector_type === 'edgetpu' || panel.values.detector_type === 'cpu') && !(panel.values.detector_model || '').startsWith('/'),
            <Text>Absolute path to a .tflite model, see detector/get_models.sh</Text>)
          invalidFn('go2rtc_path', panel.values.go2rtc_path && !panel.values.go2rtc_path.startsWith('/'),
            <Text>Must be an absolute path</Text>)
          invalidFn('mqtt_url', panel.values.mqtt_url && !/^(mqtt|mqtts|ws|wss|tcp):\/\/\S+$/i.test(panel.values.mqtt_url),
            <Text>Like mqtt://192.168.1.5:1883</Text>)
          invalidFn('mlDir', panel.values.enable_ml && (!panel.values.mlDir || panel.values.mlDir.endsWith('/') || !panel.values.mlDir.startsWith('/')),
            <Text>Must be abosolute path (cannot end with '/')</Text>)
        } else {
          invalidFn('name', !panel.values.name || panel.values.name.match(/^[a-z0-9][_\-a-z0-9]+[a-z0-9]$/i) === null || panel.values.name.length > 19,
            <Text>Enter valid camera name</Text>)
    
          invalidFn('disk', !panel.values.disk ,
            <Text>Require a Disk to store the files on, goto General Settings to create</Text>)
    
          invalidFn('folder', !panel.values.folder || panel.values.folder.startsWith('/') || panel.values.folder.endsWith('/'),
            <Text>Require a folder to store the files for this camera (relitive to disk, don't start with '/')</Text>)
    
          const isRtsp = panel.values.camera_type === 'rtsp'
          const urlRe = /^(rtsp|rtsps|rtmp|http|https):\/\/\S+$/i
          if (!isRtsp) {
            if (panel.key === "new") {
              invalidFn('ip', !panel.values.ip || panel.values.ip.match(/^([0-9]{1,3}\.){3}[0-9]{1,3}$/i) === null,
                <Text>Enter valid camera IPv4 address</Text>)
            } else {
              invalidFn('ip', panel.values.ip && panel.values.ip.match(/^([0-9]{1,3}\.){3}[0-9]{1,3}$/i) === null,
                <Text>Enter valid camera IPv4 address</Text>)
            }
          } else {
            invalidFn('ip', false)
          }
          invalidFn('rtsp_url', isRtsp && ((panel.key === 'new' && !panel.values.rtsp_url) || (panel.values.rtsp_url && !urlRe.test(panel.values.rtsp_url))),
            <Text>Enter the stream url, e.g. rtsp://user:pass@192.168.1.20:554/stream1</Text>)
          invalidFn('detect_url', panel.values.detect_url && !urlRe.test(panel.values.detect_url),
            <Text>Enter a valid stream url</Text>)
        }
    }



    const listContainsTagList = (tag, tagList) => {
      if (!tagList || !tagList.length || tagList.length === 0) {
        return false;
      }
      return tagList.some(compareTag => compareTag.key === tag.key);
    }

    function savePanel(event, ctx) {
        const {key} =  ctx && typeof ctx === 'object' ? ctx : {}

        setError(null)
        fetch(`/api/${panel.key === 'settings' ? 'settings' : `camera/${panel.values.key || 'new'}`}${key && panel.values.key ? `?delopt=${key}` : ''}`, {
        method: 'POST',
        credentials: 'same-origin',
        mode: 'cors',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(panel.values)
        }).then(res => {
        if (res.ok) {
            console.log(`created success : ${JSON.stringify(res)}`)
            getServerData()
            setPanel({open: false, invalidArray: []})
        } else {
            return res.text().then(text => {throw new Error(text)})
            //const ferr = `created failed : ${succ.status} ${succ.statusText}`
            //console.error(ferr)
            //setError(ferr)
        }
        
        }).catch(error => {
        console.error(`created failed : ${error}`)
        setError(`created failed : ${error}`)
        })
    }

    const currCamera = panel.key === 'edit' && data.cameras && panel.values.key && data.cameras.find(c => c.key === panel.values.key)

    console.log (panel.values)

    return (

        <Panel
            headerText={panel.heading}
            isOpen={panel.open}
            onDismiss={() => setPanel({...panel, open: false, invalidArray: []})}
            // You MUST provide this prop! Otherwise screen readers will just say "button" with no label.
            closeButtonAriaLabel="Close">

          { panel.open && 
            <Stack>
                { panel.key === 'settings' ? 
                <>

                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Storage Settings</b></Separator>
                    <TextField label="Disk Mount Folder" iconProps={{ iconName: 'Folder' }}  required value={panel.values.disk_base_dir} onChange={(ev, val) => updatePanelValues('disk_base_dir', val)} errorMessage={getError('disk_base_dir')} />
                    
                    <Checkbox label="Enable Disk Cleanup" checked={panel.values.enable_cleanup} onChange={(ev, val) => updatePanelValues('enable_cleanup', val)} styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}/>
                    <Slider disabled={!panel.values.enable_cleanup} label="Keep under Capacity %" min={1} max={99} step={1} defaultValue={panel.values.cleanup_capacity} showValue onChange={(val) => updatePanelValues('cleanup_capacity', val)} />
                    <Slider disabled={!panel.values.enable_cleanup} label="Check Capacity Interval (minutes)" min={1} max={60} step={1} defaultValue={panel.values.cleanup_interval} showValue onChange={(val) => updatePanelValues('cleanup_interval', val)} />


 
                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Built-in Detection (motion + objects)</b></Separator>
                    <Dropdown label="Detector" selectedKey={panel.values.detector_type || 'none'} options={detectorTypes} onChange={(ev, o) => updatePanelValues('detector_type', o.key)} />
                    { panel.values.detector_type === 'edgetpu' &&
                      <TextField label="Coral device(s)" placeholder="empty = first available" description="usb, pci, usb:0, pci:1 ... separate several with commas to use more than one Coral" value={panel.values.detector_device || ''} onChange={(ev, val) => updatePanelValues('detector_device', val)} />
                    }
                    { (panel.values.detector_type === 'edgetpu' || panel.values.detector_type === 'cpu') && <>
                      <TextField label={panel.values.detector_type === 'edgetpu' ? 'Model (*_edgetpu.tflite)' : 'Model (.tflite)'} required value={panel.values.detector_model || ''} onChange={(ev, val) => updatePanelValues('detector_model', val)} errorMessage={getError('detector_model')} />
                      <TextField label="Labels file (optional, defaults to COCO)" value={panel.values.detector_labels || ''} onChange={(ev, val) => updatePanelValues('detector_labels', val)} />
                    </>}
                    { panel.values.detector_type && panel.values.detector_type !== 'none' &&
                      <TextField label="Python (optional, e.g. /opt/nvr-venv/bin/python)" value={panel.values.detector_python || ''} onChange={(ev, val) => updatePanelValues('detector_python', val)} />
                    }
                    { data.system && data.system.detector && data.system.detector.type !== 'none' &&
                      <MessageBar styles={{ root: { marginTop: 8 } }} messageBarType={data.system.detector.state === 'running' ? MessageBarType.success : (data.system.detector.state === 'error' ? MessageBarType.error : MessageBarType.warning)}>
                        Detector {data.system.detector.state}{data.system.detector.backend ? ` (${data.system.detector.backend}` : ''}{data.system.detector.inferenceMs ? `, ${data.system.detector.inferenceMs}ms/frame` : ''}{data.system.detector.backend ? ')' : ''}{data.system.detector.error ? `: ${data.system.detector.error}` : ''}
                        {data.system.detector.workers && data.system.detector.workers.length > 1 ? ` [${data.system.detector.workers.map(w => `${w.device || 'auto'}: ${w.state}`).join(', ')}]` : ''}
                      </MessageBar>
                    }

                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Live view / RTSP restream (go2rtc)</b></Separator>
                    <TextField label="go2rtc binary (optional)" value={panel.values.go2rtc_path || ''} onChange={(ev, val) => updatePanelValues('go2rtc_path', val)} errorMessage={getError('go2rtc_path')} />
                    { data.system && data.system.go2rtc && data.system.go2rtc.enabled &&
                      <MessageBar styles={{ root: { marginTop: 8 } }} messageBarType={data.system.go2rtc.running ? MessageBarType.success : MessageBarType.error}>
                        go2rtc {data.system.go2rtc.running ? 'running' : 'not running'}{data.system.go2rtc.error ? `: ${data.system.go2rtc.error}` : ''}
                      </MessageBar>
                    }

                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>MQTT / Home Assistant</b></Separator>
                    <TextField label="Broker url (empty = off)" placeholder="mqtt://192.168.1.5:1883" value={panel.values.mqtt_url || ''} onChange={(ev, val) => updatePanelValues('mqtt_url', val)} errorMessage={getError('mqtt_url')} />
                    <TextField label="User" autoComplete="off" value={panel.values.mqtt_user || ''} onChange={(ev, val) => updatePanelValues('mqtt_user', val)} />
                    <TextField label="Password" type="password" autoComplete="new-password" value={panel.values.mqtt_password || ''} onChange={(ev, val) => updatePanelValues('mqtt_password', val)} />
                    <TextField label="Topic prefix" placeholder="nvr" value={panel.values.mqtt_prefix || ''} onChange={(ev, val) => updatePanelValues('mqtt_prefix', val)} />
                    <Checkbox label="Home Assistant MQTT discovery" checked={!!panel.values.mqtt_ha_discovery} onChange={(ev, val) => updatePanelValues('mqtt_ha_discovery', val)} styles={{ root: { marginTop: "8px !important" } }}/>
                    { data.system && data.system.mqtt && data.system.mqtt.enabled &&
                      <MessageBar styles={{ root: { marginTop: 8 } }} messageBarType={data.system.mqtt.connected ? MessageBarType.success : MessageBarType.error}>
                        MQTT {data.system.mqtt.connected ? 'connected' : 'not connected'}{data.system.mqtt.error ? `: ${data.system.mqtt.error}` : ''}
                      </MessageBar>
                    }

                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Object Detection (darknet, Reolink motion only)</b></Separator>
                    
                    <Checkbox label="Enable Object Detection" checked={panel.values.enable_ml} onChange={(ev, val) => updatePanelValues('enable_ml', val)} styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}/>
                    
                    <TextField disabled={!panel.values.enable_ml} label="Object Detection Run Folder" iconProps={{ iconName: 'Folder' }}  required value={panel.values.mlDir} onChange={(ev, val) => updatePanelValues('mlDir', val)} errorMessage={getError('mlDir')} />
                    
                    <TextField disabled={!panel.values.enable_ml} label="Object Detection Command (use {in} and {out} for images)" iconProps={{ iconName: 'Folder' }}  required value={panel.values.mlCmd} onChange={(ev, val) => updatePanelValues('mlCmd', val)} errorMessage={getError('mlCmd')} />

                    { data.config && data.config.status  &&  Object.keys(data.config.status).length > 0 && 
                    <Stack.Item>
                        <Separator/>
                        <MessageBar>{JSON.stringify(data.config.status, null, 2)}</MessageBar>
                    </Stack.Item>
                    }

                </>
                :
                <>
                    <Label>Camera ID: {panel.values.key}</Label>
                    <TextField label="Camera Name" onChange={(ev, val) => updatePanelValues('name', val)} required errorMessage={getError('name')} value={panel.values.name} />
                    <Dropdown label="Camera type" selectedKey={panel.values.camera_type || 'reolink'} options={[{ key: 'rtsp', text: 'RTSP / IP camera (any brand)' }, { key: 'reolink', text: 'Reolink (RTMP + motion API)' }]} onChange={(ev, o) => updatePanelValues('camera_type', o.key)} />
                    { panel.values.camera_type === 'rtsp' ? <>
                      <TextField label="Stream url (recorded)" required placeholder={currCamera && currCamera.rtsp_url_masked ? `${currCamera.rtsp_url_masked} (unchanged)` : 'rtsp://user:pass@192.168.1.20:554/stream1'} onChange={(ev, val) => updatePanelValues('rtsp_url', val)} errorMessage={getError('rtsp_url')} value={panel.values.rtsp_url || ''} />
                      <TextField label="Detection stream url (optional, low resolution)" placeholder={currCamera && currCamera.detect_url_masked ? `${currCamera.detect_url_masked} (unchanged)` : 'rtsp://user:pass@192.168.1.20:554/stream2'} onChange={(ev, val) => updatePanelValues('detect_url', val)} errorMessage={getError('detect_url')} value={panel.values.detect_url === undefined ? '' : panel.values.detect_url} />
                      <Checkbox label="Record audio" checked={!!panel.values.record_audio} onChange={(ev, val) => updatePanelValues('record_audio', val)} styles={{ root: { marginTop: "8px !important" } }} />
                    </> : <>
                      <TextField label="IP Address" prefix="IP" onChange={(ev, val) => updatePanelValues('ip', val)} required errorMessage={getError('ip')} value={panel.values.ip} />
                      <TextField label="admin Password" type="password"  value={panel.values.passwd} onChange={(ev, val) => updatePanelValues('passwd', val)} />
                    </>}
                    
                    <Stack horizontal tokens={{ childrenGap: 10 }}>
                    <Dropdown label="Disk" selectedKey={panel.values.disk} options={data.config && [ { key: data.config.settings.disk_base_dir, text: data.config.settings.disk_base_dir}]} required onChange={(ev, {key}) => updatePanelValues('disk', key)} errorMessage={getError('disk')} />
                    <TextField label="Steaming Folder" iconProps={{ iconName: 'Folder' }}  required value={panel.values.folder} onChange={(ev, val) => updatePanelValues('folder', val)} errorMessage={getError('folder')} />
                    </Stack>

                    <Label>Filter Tags (Requires Object Detection)</Label>
                    <TagPicker
                    disabled={data.config && !data.config.settings.enable_ml && (data.config.settings.detector_type || 'none') === 'none'}
                    onChange={(i) => panel.values.ignore_tags = i.map(i => i.key)}
                    defaultSelectedItems={panel.values.ignore_tags ? panel.values.ignore_tags.map(i => {return {key:i,name:i}} ) : []}
                    removeButtonAriaLabel="Remove"
                    selectionAriaLabel="Selected colors"
                    onResolveSuggestions={(filterText, tagList) => {
                        return filterText
                        ? cocoNames.filter(
                            tag => tag.name.toLowerCase().indexOf(filterText.toLowerCase()) === 0 && !listContainsTagList(tag, tagList),
                            )
                        : [];
                    }}
                    getTextFromItem={(i) => i.name}
                    pickerSuggestionsProps={{
                        suggestionsHeaderText: 'Suggested tags',
                        noResultsFoundText: 'No tags found',
                    }}
                    />

                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Playback</b></Separator>
                    <Checkbox label="Enable Streaming" checked={panel.values.enable_streaming} onChange={(ev, val) => { updatePanelValues('enable_streaming', val)} } />

                    { currCamera && currCamera.ffmpeg_process &&
                    <Stack.Item>
                        <Separator/>
                        <MessageBar messageBarType={currCamera.ffmpeg_process.error ? MessageBarType.error : (currCamera.ffmpeg_process.running ?  MessageBarType.success : MessageBarType.warning)}>{JSON.stringify(currCamera.ffmpeg_process, null, 2)}</MessageBar>
                    </Stack.Item>
                    }

                    <Stack styles={{ root: { marginTop: "15px !important"} }}>
                    <Slider disabled={!panel.values.enable_streaming} label="Segments(2s) prior to movement" min={0} max={60} step={1} defaultValue={panel.values.segments_prior_to_movement} showValue onChange={(val) => updatePanelValues('segments_prior_to_movement', val)} />
                    <Slider disabled={!panel.values.enable_streaming} label="Segments(2s) post movement" min={0} max={60} step={1} defaultValue={panel.values.segments_post_movement} showValue onChange={(val) => updatePanelValues('segments_post_movement', val)} />
                    </Stack>

                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Movement processing</b></Separator>
                    
                    <Checkbox disabled={!panel.values.enable_streaming} label="Enable Movement" checked={panel.values.enable_movement} onChange={(ev, val) => updatePanelValues('enable_movement', val)} />
                    
                    { currCamera && currCamera.movementStatus &&
                    <Stack.Item>
                        <Separator/>
                        <MessageBar messageBarType={currCamera.movementStatus.fail ? MessageBarType.error : (currCamera.movementStatus.current_movement ?  MessageBarType.success : MessageBarType.warning)}>{JSON.stringify(currCamera.movementStatus, null, 2)}</MessageBar>
                    </Stack.Item>
                    }

                    { data.config && (data.config.settings.detector_type || 'none') !== 'none' && <>
                      <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Built-in detection</b></Separator>
                      <Checkbox disabled={!panel.values.enable_movement || (panel.values.camera_type !== 'rtsp' && !panel.values.detect_url && !(currCamera && currCamera.detect_url_masked))} label={panel.values.camera_type === 'rtsp' ? 'Detect motion and objects' : 'Detect motion and objects (needs an RTSP detection stream url)'} checked={!!panel.values.detect_enabled} onChange={(ev, val) => updatePanelValues('detect_enabled', val)} />
                      { panel.values.camera_type !== 'rtsp' &&
                        <TextField label="Detection stream url (rtsp://...)" placeholder={currCamera && currCamera.detect_url_masked ? `${currCamera.detect_url_masked} (unchanged)` : ''} onChange={(ev, val) => updatePanelValues('detect_url', val)} errorMessage={getError('detect_url')} value={panel.values.detect_url === undefined ? '' : panel.values.detect_url} />
                      }
                      { panel.values.detect_enabled && <>
                        <Label>Objects that start an event</Label>
                        <TagPicker
                          onChange={(i) => updatePanelValues('track_objects', (i || []).map(i => i.key))}
                          defaultSelectedItems={(panel.values.track_objects || []).map(i => ({ key: i, name: i }))}
                          removeButtonAriaLabel="Remove"
                          onResolveSuggestions={(filterText, tagList) => filterText ? cocoNames.filter(tag => tag.name.toLowerCase().indexOf(filterText.toLowerCase()) === 0 && !listContainsTagList(tag, tagList)) : []}
                          getTextFromItem={(i) => i.name}
                          inputProps={{ placeholder: 'person, car, dog, cat (default)' }}
                        />
                        <Checkbox label="Only record events with a tracked object (otherwise any motion)" checked={panel.values.require_object !== false} onChange={(ev, val) => updatePanelValues('require_object', val)} styles={{ root: { marginTop: "8px !important" } }} />
                        <Slider label="Minimum confidence %" min={30} max={95} step={5} defaultValue={Math.round((panel.values.min_score || 0.6) * 100)} showValue onChange={(val) => updatePanelValues('min_score', val / 100)} />
                        <Slider label="Motion sensitivity: pixel change (lower = more sensitive)" min={5} max={100} step={5} defaultValue={panel.values.motion_threshold || 25} showValue onChange={(val) => updatePanelValues('motion_threshold', val)} />
                        <Slider label="Motion area: % of frame" min={0} max={20} step={0.5} defaultValue={panel.values.motion_area === undefined ? 1 : panel.values.motion_area} showValue onChange={(val) => updatePanelValues('motion_area', val)} />
                        <Slider label="Detection resolution (width px, higher finds smaller objects, costs CPU)" min={320} max={1280} step={160} defaultValue={panel.values.detect_width || 640} showValue onChange={(val) => updatePanelValues('detect_width', val)} />
                        <Slider label="Detection frames per second" min={1} max={15} step={1} defaultValue={panel.values.detect_fps || 5} showValue onChange={(val) => updatePanelValues('detect_fps', val)} />
                        <DefaultButton text={`Zones and masks (${(panel.values.zones || []).length} zones, ${(panel.values.motion_mask || []).length + (panel.values.object_mask || []).length} masks)`} disabled={!panel.values.key} title={panel.values.key ? '' : 'Save the camera first'} onClick={() => setZoneEditor(true)} styles={{ root: { marginTop: 8 } }} />
                        { currCamera && currCamera.detect &&
                          <MessageBar styles={{ root: { marginTop: 8 } }} messageBarType={currCamera.detect.error ? MessageBarType.error : (currCamera.detect.running ? MessageBarType.success : MessageBarType.warning)}>
                            {currCamera.detect.running ? `Detecting at ${currCamera.detect.fps} fps` : 'Detection not running'}{currCamera.detect.motion ? ', motion' : ''}{currCamera.detect.objects.length ? `, seeing: ${currCamera.detect.objects.map(o => o.label).join(', ')}` : ''}{currCamera.detect.error ? ` - ${currCamera.detect.error}` : ''}
                          </MessageBar>
                        }
                      </>}
                    </>}

                    <Stack styles={{ root: { marginTop: "15px !important"} }}>
                    <Slider disabled={!panel.values.enable_movement} label="Poll Frequency (mS)" min={1000} max={10000} step={500} defaultValue={panel.values.mSPollFrequency} showValue onChange={(val) => updatePanelValues('mSPollFrequency', val)} />
                    <Slider disabled={!panel.values.enable_movement} label="Continuation if no movement for (s)" min={0} max={50} step={1} defaultValue={panel.values.secWithoutMovement} showValue onChange={(val) => updatePanelValues('secWithoutMovement', val)} />
                    <Slider disabled={!panel.values.enable_movement} label="Max. Single Movement (s)" min={60} max={600} step={10} defaultValue={panel.values.secMaxSingleMovement} showValue onChange={(val) => updatePanelValues('secMaxSingleMovement', val)} />
                    {panel.key}
                    </Stack>


                    { panel.key === 'edit' &&
                    <Stack styles={{ root: { marginTop: "15px !important"} }}>
                        <DefaultButton  text="Delete" disabled={panel.invalidArray.length >0} split menuProps={{ items: [
                        {
                            key: 'del',
                            text: 'Delete Camera',
                            iconProps: { iconName: 'Delete' },
                            onClick: savePanel
                        },
                        {
                            key: 'delall',
                            text: 'Delete Camera & Recordings',
                            iconProps: { iconName: 'Delete' },
                            onClick: savePanel
                        }]}} />
                        </Stack>
                    }

                </>
            }

                <PrimaryButton styles={{ root: { marginTop: "15px !important"}}} disabled={panel.invalidArray.length >0} text="Save" onClick={savePanel}/>

                {error &&
                <MessageBar messageBarType={MessageBarType.error} isMultiline={false} truncated={true}>
                {error}
                </MessageBar>
            }
            </Stack>
        }
        {zoneEditor && panel.open && panel.values.key &&
          <ZoneEditor cameraKey={panel.values.key} value={panel.values} objectNames={cocoNames}
            onDismiss={() => setZoneEditor(false)}
            onSave={(shapes) => { setPanel(prev => ({ ...prev, values: { ...prev.values, ...shapes } })); setZoneEditor(false) }} />
        }
      </Panel>
    )
}