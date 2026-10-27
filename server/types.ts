import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { DetectorConfig } from './detector_client.js'
import type { DetectSettings, DetectState } from './detect.js'
import type { MqttSettings } from './mqtt.js'

export interface Settings extends MqttSettings {
    disk_base_dir: string;
    enable_cleanup: boolean;
    cleanup_interval: number;
    cleanup_capacity: number;
    enable_ml: boolean;
    mlDir: string;
    mlCmd: string;
    // built-in object detection (Coral EdgeTPU / CPU), see detector/
    detector_type?: DetectorConfig['type'];
    detector_device?: string;
    detector_model?: string;
    detector_labels?: string;
    detector_python?: string;
    // path to a go2rtc binary, enables RTSP restream + low latency live view
    go2rtc_path?: string;
}

export interface MovementEntry {
    cameraKey: string;
    startDate: number;
    startSegment: number;
    lhs_seg_duration_seq?: number;
    seconds: number;
    consecutivesecondswithout: number;
    // stored while the event is still running, so a crash does not lose it
    ongoing?: boolean;
    ml?: MLData;
    ml_movejpg?: SpawnData;
    ffmpeg?: SpawnData;
}

export interface MovementToClient {
    key: number;
    movement: MovementEntry;
    startDate_en_GB: string;
}

export interface SpawnData {
    success: boolean;
    code: number;
    stdout: string;
    stderr: string;
    error: string;
}

export interface MLData extends SpawnData {
    tags: any[];
}

export interface CameraEntry extends DetectSettings {
    delete: boolean;
    name: string;
    folder: string;
    disk: string;
    // reolink (default): RTMP + camera motion API. rtsp: any RTSP camera, motion/objects from built-in detection
    camera_type?: 'reolink' | 'rtsp';
    ip?: string;
    passwd?: string;
    // rtsp cameras: stream to record, and optional (lower resolution) stream used for detection
    rtsp_url?: string;
    detect_url?: string;
    record_audio?: boolean;
    enable_streaming: boolean;
    enable_movement: boolean;
    secWithoutMovement: number;
    secMaxSingleMovement: number;
    mSPollFrequency: number;
    segments_prior_to_movement: number;
    segments_post_movement: number;
    ignore_tags: string[];
}

export interface ProcessInfo {
    taskid: ChildProcessWithoutNullStreams | null;
    check_after?: number;
    in_progress: boolean;
    error: boolean;
    running: boolean;
    status: string;
}

export interface MovementStatus {
    in_progress: boolean;
    fail: boolean;
    check_after?: number;
    status?: string;
    current_movement?: MovementEntry | null;
}

export interface CameraEntryClient extends Omit<CameraEntry, 'ip' | 'passwd' | 'rtsp_url' | 'detect_url'> {
    key: string
    rtsp_url_masked?: string;
    detect_url_masked?: string;
    live_stream?: string;
    detect?: DetectState;
    ffmpeg_process?: ProcessInfo;
    movementStatus?: MovementStatus;
}

export interface CameraCacheEntry {
    ce: CameraEntry;
    ffmpeg_process?: ProcessInfo;
    movementStatus?: MovementStatus;
}

export interface CameraCache { 
    [key: string]: CameraCacheEntry;
}

export interface SettingsCache {
    settings: Settings;
    status: SettingsStatus;
}

export interface SettingsStatus { 
    nextCheckInMinutes: number;
    lastChecked?: Date;
    fail: boolean;
    error?: string;
}
