import mqtt from 'mqtt'
import type { MqttClient } from 'mqtt'

export interface MqttSettings {
    mqtt_url?: string;
    mqtt_user?: string;
    mqtt_password?: string;
    mqtt_prefix?: string;
    mqtt_ha_discovery?: boolean;
}

export interface EventMessage {
    type: 'new' | 'end';
    camera: string;
    key: number;
    start_time: number;
    end_time?: number;
    labels: string[];
    tags?: { tag: string; probability: number; zones?: string[] }[];
}

// Home Assistant discovery sensors for these labels (the default tracked set)
const HA_LABELS = ['person', 'car', 'dog', 'cat']

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')

// Publishes camera state in a Frigate-like layout:
//   <prefix>/available                 online | offline (last will)
//   <prefix>/<camera>/motion           ON | OFF
//   <prefix>/<camera>/<label>          object count (also <label> = all)
//   <prefix>/events                    JSON, new/end of a recorded event
//   <prefix>/stats                     JSON detector + camera stats
export class MqttPublisher {

    private client: MqttClient | null = null
    private cfg: MqttSettings = {}
    private cameras = new Set<string>()
    connected = false
    error?: string

    get prefix(): string {
        return safe(this.cfg.mqtt_prefix || 'nvr')
    }

    configure(cfg: MqttSettings) {
        const same = this.cfg.mqtt_url === cfg.mqtt_url && this.cfg.mqtt_user === cfg.mqtt_user &&
            this.cfg.mqtt_password === cfg.mqtt_password && this.cfg.mqtt_prefix === cfg.mqtt_prefix
        this.cfg = cfg
        if (same && this.client) {
            if (cfg.mqtt_ha_discovery) this.cameras.forEach(c => this.discover(c))
            return
        }
        this.close()
        if (!cfg.mqtt_url) return
        try {
            const client = mqtt.connect(cfg.mqtt_url, {
                username: cfg.mqtt_user || undefined,
                password: cfg.mqtt_password || undefined,
                reconnectPeriod: 10000,
                will: { topic: `${this.prefix}/available`, payload: Buffer.from('offline'), retain: true, qos: 1 }
            })
            this.client = client
            client.on('connect', () => {
                this.connected = true
                this.error = undefined
                console.log(`mqtt: connected to ${cfg.mqtt_url?.replace(/\/\/[^@/]*@/, '//****@')}`)
                client.publish(`${this.prefix}/available`, 'online', { retain: true })
                if (this.cfg.mqtt_ha_discovery) this.cameras.forEach(c => this.discover(c))
            })
            client.on('close', () => { this.connected = false })
            client.on('error', (e: Error) => { this.error = e.message })
        } catch (e) {
            this.error = (e as Error).message
        }
    }

    close() {
        this.connected = false
        this.client?.end(true)
        this.client = null
    }

    registerCamera(name: string) {
        this.cameras.add(name)
        if (this.cfg.mqtt_ha_discovery && this.connected) this.discover(name)
    }

    publish(subtopic: string, payload: string | object, retain = false) {
        if (!this.client || !this.connected) return
        this.client.publish(`${this.prefix}/${subtopic}`, typeof payload === 'string' ? payload : JSON.stringify(payload), { retain })
    }

    motion(camera: string, on: boolean) {
        this.publish(`${safe(camera)}/motion`, on ? 'ON' : 'OFF', true)
    }

    objects(camera: string, changed: { [label: string]: number }, all: { [label: string]: number }) {
        for (const [label, n] of Object.entries(changed)) {
            this.publish(`${safe(camera)}/${safe(label)}`, String(n), true)
        }
        this.publish(`${safe(camera)}/all`, String(Object.values(all).reduce((a, b) => a + b, 0)), true)
    }

    event(e: EventMessage) {
        this.publish('events', e)
    }

    stats(s: object) {
        this.publish('stats', s)
    }

    private discover(camera: string) {
        const cam = safe(camera)
        const base = { availability_topic: `${this.prefix}/available`, device: { identifiers: [`${this.prefix}_${cam}`], name: camera, manufacturer: 'open-source-nvr' } }
        const send = (kind: string, id: string, body: object) =>
            this.client?.publish(`homeassistant/${kind}/${this.prefix}_${cam}_${id}/config`, JSON.stringify({ ...base, unique_id: `${this.prefix}_${cam}_${id}`, ...body }), { retain: true })
        send('binary_sensor', 'motion', { name: `${camera} motion`, device_class: 'motion', state_topic: `${this.prefix}/${cam}/motion`, payload_on: 'ON', payload_off: 'OFF' })
        for (const l of HA_LABELS.concat('all')) {
            send('sensor', l, { name: `${camera} ${l}`, state_topic: `${this.prefix}/${cam}/${l}`, state_class: 'measurement' })
        }
    }
}

export const mqttPublisher = new MqttPublisher()
