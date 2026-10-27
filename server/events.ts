import { diskCheck } from './diskcheck.js'
import type { DiskCheckReturn } from './diskcheck.js'
import { JobTask } from './jobmanager.js'
import type { JobManager } from './jobmanager.js'
import { cameraCache, movementdb } from './state.js'
import type { MovementEntry } from './types.js'

export async function clearDownDisk(diskDir: string, cameraKeys : Array<string>, cleanupCapacity: number) : Promise<DiskCheckReturn> {
    const diskres = await diskCheck(diskDir, cameraKeys.map(key => `${diskDir}/${cameraCache[key].ce.folder}`), cleanupCapacity)
    console.log(diskres)
    if (diskres.revmovedMBTotal > 0) {
        const mostRecentctimMs = Object.keys(diskres.folderStats).reduce((acc, cur) => diskres.folderStats[cur].lastRemovedctimeMs ? (  diskres.folderStats[cur].lastRemovedctimeMs > acc? diskres.folderStats[cur].lastRemovedctimeMs : acc ) : acc ,0)
        if (mostRecentctimMs > 0 || cleanupCapacity === -1) {
            const keytoDeleteTo =  cleanupCapacity === -1 ? null : (mostRecentctimMs / 1000 | 0) - 1600000000
            const deleteKeys : Array<number> = await new Promise((res, _rej) => {
                let keys : Array<number> = []
                movementdb.createReadStream(keytoDeleteTo && {lte: keytoDeleteTo})
                .on('data', (data) => {
                    const { key, value } = data as {key: number, value: MovementEntry}
                    if (cameraKeys.includes(value.cameraKey)) {  
                        keys.push(key) 
                    }})
                .on('end', () => {
                    res(keys)
                })
            })

            if (deleteKeys.length > 0) {
                console.log(`deleting ${deleteKeys.length} keys from movementdb`)
                await movementdb.batch([...deleteKeys.map(k => { return {type: 'del', key: k} })] as any)
            }

        }
    }
    return diskres
}

// Events that were still running when the server stopped: close them and take their snapshot
export async function recoverEvents(jobManager: JobManager) {
    const stale: { key: number; value: MovementEntry }[] = await new Promise((res, rej) => {
        const out: { key: number; value: MovementEntry }[] = []
        movementdb.createReadStream().on('data', (d) => {
            const { key, value } = d as { key: number; value: MovementEntry }
            if (value.ongoing) out.push({ key, value })
        }).on('end', () => res(out)).on('error', rej)
    })
    for (const { key, value } of stale) {
        const { ongoing, ...closed } = value
        await movementdb.put(key, closed)
        if (cameraCache[closed.cameraKey]) await jobManager.submit({ task: JobTask.Snapshot, movement_key: key })
    }
    if (stale.length > 0) console.log(`recovered ${stale.length} events that were running at shutdown`)
}
